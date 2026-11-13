import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnCaptureAsync } from '../execUtils.js';
import { assertDockerRuntime } from './dockerRuntime.js';
import type { WorkspaceBackend } from './types.js';

vi.mock('../execUtils.js', () => ({ spawnCaptureAsync: vi.fn() }));

let fault = '';
let marker = '';
let publicCalls = 0;
let create: ReturnType<typeof vi.fn>;
let exec: ReturnType<typeof vi.fn>;
let copyFileIn: ReturnType<typeof vi.fn>;
let lockEgress: ReturnType<typeof vi.fn>;
let remove: ReturnType<typeof vi.fn>;
let backend: WorkspaceBackend;
let workspaceName = '';
const ok = (stdout = '') => ({ exitCode: 0, stderr: '', stdout });
const blocked = () => ({ exitCode: 1, stderr: 'Connection refused', stdout: '' });

beforeEach(() => {
  fault = '';
  marker = '';
  publicCalls = 0;
  vi.stubEnv('WORKSPACE_BACKEND', 'docker');
  vi.stubEnv('WORKSPACE_RUNTIME', 'runsc-host');
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  create = vi.fn(async (spec) => {
    workspaceName = spec.name;
    if (fault === 'create') {
      throw new Error('baseline unavailable');
    }
    return { id: spec.name, keeperPid: 7 };
  });
  exec = vi.fn(async (_handle, argv: string[]) => {
    if (argv[0] === 'wget') {
      return fault === 'private' ? ok(marker) : blocked();
    }
    if (argv[0] === 'nc') {
      publicCalls++;
      return fault === 'inconclusive' || (publicCalls > 1 && fault !== 'public') ? blocked() : ok();
    }
    if (argv[0] === 'cat') {
      return fault === 'copy visibility' ? blocked() : ok(marker);
    }
    if (fault === 'tools' && argv[0] === 'sh') {
      return blocked();
    }
    return ok();
  });
  copyFileIn = vi.fn(async (_handle, source) => {
    expect(await fs.readFile(source, 'utf8')).toBe(marker);
    return fault === 'copy in' ? blocked() : ok();
  });
  lockEgress = vi.fn(async () => {
    if (fault === 'lock') {
      throw new Error('lock verification failed');
    }
  });
  remove = vi.fn(async () => undefined);
  backend = { copyFileIn, create, exec, lockEgress, remove } as unknown as WorkspaceBackend;
  vi.mocked(spawnCaptureAsync).mockImplementation(async (_bin, args) => {
    if (args[0] === 'run' && args.includes('--runtime=runsc-host') && fault === 'runtime') {
      return blocked();
    }
    if (args[0] === 'run' && args.includes('sh')) {
      marker = String(args.at(-1)).match(/echo ([a-f0-9]+)/)?.[1] ?? '';
      return ok();
    }
    if (args[0] === 'inspect') {
      if (args.includes('{{.HostConfig.Runtime}}')) {
        return ok(fault === 'inspect' ? 'runc' : 'runsc-host');
      }
      if (args.includes('{{json .}}')) {
        if (args.at(-1) === 'holder') {
          return ok(
            JSON.stringify({
              Config: {
                Labels: {
                  'asw.workspace': fault === 'foreign holder' ? 'other' : workspaceName,
                  'auto-swe.workspace': 'true',
                },
              },
              NetworkSettings: { Networks: { private: {} } },
            })
          );
        }
        return ok(
          JSON.stringify({
            HostConfig: {
              Runtime: fault === 'workspace runtime' ? 'runc' : 'runsc-host',
              ...(fault === 'shared network' || fault === 'foreign holder'
                ? { NetworkMode: 'container:holder' }
                : {}),
            },
            NetworkSettings: {
              Networks: ['network', 'shared network', 'foreign holder'].includes(fault)
                ? {}
                : { private: {} },
            },
          })
        );
      }
      return ok(fault === 'ip' ? '' : '172.18.0.2');
    }
    if (args[0] === 'exec') {
      return ok(fault === 'peer' ? '' : marker);
    }
    if (args[0] === 'cp') {
      await fs.writeFile(String(args[2]), fault === 'copy out' ? 'wrong' : marker);
    }
    return ok();
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe('Docker runtime boot gate', () => {
  it('runs the same traffic and copy assertions through the owned shared-network holder', async () => {
    fault = 'shared network';
    await assertDockerRuntime(backend);
    expect(publicCalls).toBe(2);
    expect(copyFileIn).toHaveBeenCalledOnce();
    expect(lockEgress).toHaveBeenCalledOnce();
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('checks passed'));
  });
  it.each(['', undefined])('does nothing with runtime %j', async (runtime) => {
    vi.stubEnv('WORKSPACE_RUNTIME', runtime);
    await assertDockerRuntime(backend);
    expect(create).not.toHaveBeenCalled();
    expect(spawnCaptureAsync).not.toHaveBeenCalled();
  });
  it('does not run Docker probes for Kubernetes', async () => {
    vi.stubEnv('WORKSPACE_BACKEND', 'kubernetes');
    await assertDockerRuntime(backend);
    expect(spawnCaptureAsync).not.toHaveBeenCalled();
  });
  it('uses the real backend baseline, checks traffic before/after blocked locking, copies and cleans up', async () => {
    await assertDockerRuntime(backend);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.stringMatching(/^workspace-runtime-/) })
    );
    expect(lockEgress).toHaveBeenCalledWith(expect.anything(), [], { mode: 'blocked' });
    expect(publicCalls).toBe(2);
    expect(copyFileIn).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(exec.mock.invocationCallOrder[0]).toBeLessThan(lockEgress.mock.invocationCallOrder[0]);
    expect(lockEgress.mock.invocationCallOrder[0]).toBeLessThan(
      copyFileIn.mock.invocationCallOrder[0]
    );
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('checks passed'));
    const run = vi.mocked(spawnCaptureAsync).mock.calls.filter(([, args]) => args[0] === 'run');
    expect(run[0][1]).toContain('--runtime=runsc-host');
    expect(run[1][1]).toContain('private');
    expect(run[1][1]).not.toContain('--runtime=runsc-host');
  });
  it.each([
    ['runtime', 'runtime startup/inspection'],
    ['inspect', 'Docker returned runtime'],
    ['create', 'workspace creation/baseline'],
    ['workspace runtime', 'workspace did not use runtime'],
    ['network', 'no Docker network'],
    ['foreign holder', 'network holder is not owned'],
    ['tools', 'requires wget and nc'],
    ['peer', 'positive control failed'],
    ['ip', 'no IPv4 address'],
    ['private', 'baseline traffic leak'],
    ['public', 'blocked traffic leak'],
    ['inconclusive', 'enforcement is inconclusive'],
    ['lock', 'lock verification failed'],
    ['copy in', 'docker cp round trip'],
    ['copy visibility', 'not visible via exec'],
    ['copy out', 'did not match'],
  ])('refuses %s failure and always cleans every resource', async (failure, message) => {
    fault = failure;
    await expect(assertDockerRuntime(backend)).rejects.toThrow(message);
    expect(remove).toHaveBeenCalledOnce();
    expect(spawnCaptureAsync).toHaveBeenCalledWith(
      'docker',
      ['rm', '-f', expect.stringContaining('-inspect'), expect.stringContaining('-peer')],
      expect.anything()
    );
  });
});
