import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execShellAsync, spawnCaptureAsync, spawnWithStdinAsync } from '../execUtils.js';
import { dockerWorkspaceBackend } from './docker.js';

const group = vi.hoisted(() => ({
  childArgs: vi.fn(),
  destroy: vi.fn(),
  install: vi.fn(),
  start: vi.fn(),
}));
vi.mock('../execUtils.js', async (original) => ({
  ...(await original<typeof import('../execUtils.js')>()),
  execShellAsync: vi.fn(),
  spawnCaptureAsync: vi.fn(),
  spawnWithStdinAsync: vi.fn(),
}));
vi.mock('./kataNetwork.js', async (original) => ({
  ...(await original<typeof import('./kataNetwork.js')>()),
  KataNetworkGroup: class {
    holder: string;
    constructor(owner: string) {
      this.holder = `${owner}-net`;
    }
    start = group.start;
    install = group.install;
    destroy = group.destroy;
    childArgs = group.childArgs;
  },
}));
const backend = dockerWorkspaceBackend();
const spec = {
  cpus: 1,
  dns: ['1.1.1.1'],
  image: 'untrusted:1',
  memory: '512m',
  name: 'workspace-kata-test',
  pidsLimit: 128,
  reachWorker: false,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('WORKSPACE_RUNTIME', 'io.containerd.kata.v2');
  vi.stubEnv('WORKSPACE_RUN_AS_ROOT', '');
  group.start.mockResolvedValue(undefined);
  group.install.mockResolvedValue(undefined);
  group.destroy.mockResolvedValue(undefined);
  group.childArgs.mockReturnValue([
    '--annotation=io.kubernetes.cri.container-type=container',
    `--annotation=io.kubernetes.cri.sandbox-id=${'a'.repeat(64)}`,
  ]);
  vi.mocked(execShellAsync).mockImplementation(async (command) =>
    command.includes('PPid:') ? '7\n' : ''
  );
  vi.mocked(spawnCaptureAsync).mockImplementation(async (_bin, args) => ({
    exitCode: 0,
    stderr: '',
    stdout: args[0] === 'inspect' ? '[]' : args[0] === 'exec' ? '127.0.0.1 localhost\n' : '',
  }));
});
afterEach(async () => {
  await backend.remove(spec.name);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Docker Kata integration', () => {
  it.each([false, true])(
    'verifies daemon host pins through guest cache (permanently stale: %s)',
    async (stale) => {
      vi.stubEnv('DOCKER_BROKER_REQUIRED', 'false');
      const handle = await backend.create(spec);
      const hosts = '127.0.0.1 localhost\n';
      let written = '';
      let reads = 0;
      const id = 'b'.repeat(64);
      vi.mocked(spawnWithStdinAsync).mockImplementation(async (_bin, args, data) => {
        expect(args).toContain('--label=auto-swe.target=workspace-kata-test-net');
        expect(args).toContain(
          `type=bind,src=/var/lib/docker/containers/${id}/hosts,dst=/asw-hosts`
        );
        written = String(data);
        return { exitCode: 0, stderr: '', stdout: '' };
      });
      vi.mocked(spawnCaptureAsync).mockImplementation(async (_bin, args) => {
        let stdout = '';
        if (args.includes('/etc/hosts')) {
          reads++;
          stdout = written && reads > 2 && !stale ? written : hosts;
        } else if (args.includes('getent')) {
          stdout = '1.1.1.1 STREAM allowed.example\n';
        } else if (args.includes('{{.Id}}\t{{.HostsPath}}')) {
          expect(args.at(-1)).toBe('workspace-kata-test-net');
          stdout = `${id}\t/var/lib/docker/containers/${id}/hosts\n`;
        } else if (args[0] === 'inspect') {
          stdout = '[]';
        }
        return { exitCode: 0, stderr: '', stdout };
      });
      if (stale) {
        let now = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => {
          now += 6000;
          return now;
        });
        await expect(
          backend.lockEgress(handle, [{ host: 'allowed.example', port: 443 }], {
            prepareOnly: true,
            replace: true,
          })
        ).rejects.toThrow('not visible');
        expect(group.destroy).toHaveBeenCalledOnce();
      } else {
        await backend.lockEgress(handle, [{ host: 'allowed.example', port: 443 }], {
          prepareOnly: true,
          replace: true,
        });
        expect(reads).toBe(3);
        expect(written).toBe(`${hosts}\n1.1.1.1\tallowed.example\n`);
        expect(group.install).not.toHaveBeenCalled();
      }
    }
  );
  it('starts no workspace or preview code before the guarded group is ready', async () => {
    let release = () => {};
    group.start.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const pending = backend.create({
      ...spec,
      services: [{ image: 'untrusted-preview:1', name: 'preview', port: 8080 }],
    });
    expect(group.start).toHaveBeenCalledOnce();
    expect(execShellAsync).not.toHaveBeenCalled();
    expect(group.childArgs).not.toHaveBeenCalled();
    const args = group.start.mock.calls[0]?.[0] as string[];
    expect(args).toContain('--runtime=runc');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).not.toContain('untrusted:1');
    expect(args).not.toContain('-v');
    release();
    await pending;
    const commands = vi.mocked(execShellAsync).mock.calls.map(([command]) => command);
    expect(commands.find((command) => command.startsWith('docker run'))).toContain(
      'container:workspace-kata-test-net'
    );
    expect(commands.find((command) => command.includes('untrusted-preview:1'))).toContain(
      'io.kubernetes.cri.sandbox-id='
    );
  });
  it('removes the group if preparation fails and never starts the author image', async () => {
    group.start.mockRejectedValue(new Error('tc verification failed'));
    await expect(backend.create(spec)).rejects.toThrow('tc verification failed');
    expect(group.destroy).toHaveBeenCalled();
    expect(
      vi.mocked(execShellAsync).mock.calls.some(([command]) => command.includes('untrusted:1'))
    ).toBe(false);
  });
  it('removes the workspace and group after replacement failure', async () => {
    const handle = await backend.create(spec);
    group.install.mockRejectedValue(new Error('ct generation failed'));
    await expect(
      backend.lockEgress(handle, [], { mode: 'blocked', replace: true })
    ).rejects.toThrow('ct generation failed');
    expect(group.destroy).toHaveBeenCalledOnce();
    expect(execShellAsync).toHaveBeenCalledWith('docker rm -f workspace-kata-test');
  });
  it('installs the empty lock before a network-none author starts', async () => {
    await backend.runEphemeral(
      { image: 'untrusted:1', name: spec.name, network: 'none' },
      { heartbeatLabel: 'Kata test' }
    );
    expect(group.install).toHaveBeenCalledWith();
    expect(group.start.mock.calls[0]?.[0]).toContain('--network=bridge');
    const author = vi
      .mocked(spawnCaptureAsync)
      .mock.calls.findIndex(([, args]) => args[0] === 'run');
    expect(author).toBeGreaterThanOrEqual(0);
    expect(group.install.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(spawnCaptureAsync).mock.invocationCallOrder[author] ?? 0
    );
    const args = vi.mocked(spawnCaptureAsync).mock.calls[author]?.[1] ?? [];
    expect(args).toContain('--network=container:workspace-kata-test-net');
    expect(args).toContain('--annotation=io.kubernetes.cri.container-type=container');
  });
});
