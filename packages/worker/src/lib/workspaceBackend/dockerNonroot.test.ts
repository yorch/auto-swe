import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execShellAsync, spawnCaptureAsync } from '../execUtils.js';
import { dockerWorkspaceBackend } from './docker.js';
import type { WorkspaceContainerSpec } from './types.js';

vi.mock('../execUtils.js', async (original) => ({
  ...(await original<typeof import('../execUtils.js')>()),
  execShellAsync: vi.fn(),
  spawnCaptureAsync: vi.fn(),
}));

const spec: WorkspaceContainerSpec = {
  cpus: 1,
  dns: [],
  env: ['HOME=/root', 'OTHER=value'],
  image: 'executor:1',
  memory: '1g',
  name: 'workspace-nonroot',
  pidsLimit: 64,
  reachWorker: false,
};
const backend = dockerWorkspaceBackend();
const handle = backend.attach(spec.name);
const ok = { exitCode: 0, stderr: '', stdout: '' };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('WORKSPACE_RUN_AS_ROOT', '');
  vi.stubEnv('WORKSPACE_BLOCK_METADATA', 'false');
  vi.stubEnv('WORKSPACE_BLOCK_PRIVATE_EGRESS', 'false');
  vi.mocked(execShellAsync).mockImplementation(async (command) =>
    command.includes('PPid:') ? '7\n' : ''
  );
  vi.mocked(spawnCaptureAsync).mockResolvedValue(ok);
});
afterEach(() => vi.unstubAllEnvs());

describe('Docker workspace user', () => {
  it.each(['', 'false', 'TRUE'])('uses UID/GID 1000 and a writable HOME for %j', async (raw) => {
    vi.stubEnv('WORKSPACE_RUN_AS_ROOT', raw);
    let source = '';
    vi.mocked(spawnCaptureAsync).mockImplementation(async (_file, args) => {
      expect(args.slice(0, 2)).toEqual(['cp', '-a']);
      source = args[2];
      expect((await fs.stat(path.join(source, '.home'))).isDirectory()).toBe(true);
      expect((await fs.stat(path.join(source, 'target-repo'))).isDirectory()).toBe(true);
      return ok;
    });
    await backend.create(spec);
    const command = vi.mocked(execShellAsync).mock.calls[0][0];
    expect(command).toContain('--init --user 1000:1000');
    expect(command).toContain('--cap-drop=ALL --security-opt=no-new-privileges');
    expect(command).toContain("-e 'HOME=/root' -e 'OTHER=value' -e HOME=/workspace/.home");
    expect(command).not.toContain('--privileged');
    expect(spawnCaptureAsync).toHaveBeenCalledWith(
      'docker',
      ['cp', '-a', source, 'workspace-nonroot:/'],
      expect.anything()
    );
    await expect(fs.stat(source)).rejects.toThrow();
  });

  it('preserves image-defined user, HOME and copy semantics with the explicit opt-out', async () => {
    vi.stubEnv('WORKSPACE_RUN_AS_ROOT', 'true');
    await backend.create(spec);
    const command = vi.mocked(execShellAsync).mock.calls[0][0];
    expect(command).not.toContain('--user');
    expect(command).not.toContain('HOME=/workspace/.home');
    expect(command).toContain("-e 'HOME=/root'");
    expect(spawnCaptureAsync).not.toHaveBeenCalled();
    await backend.copyIn(handle, '/host/tree.tar', '/workspace');
    expect(execShellAsync).toHaveBeenLastCalledWith(
      "docker cp - 'workspace-nonroot:/workspace' < '/host/tree.tar'",
      expect.anything()
    );
    await backend.copyFileIn(handle, '/host/binary', '/workspace/binary');
    expect(spawnCaptureAsync).toHaveBeenLastCalledWith(
      'docker',
      ['cp', '/host/binary', 'workspace-nonroot:/workspace/binary'],
      expect.anything()
    );
  });

  it.each(['exit', 'throw'])(
    'fails closed and cleans directories and the container on preparation %s',
    async (failure) => {
      let source = '';
      vi.mocked(spawnCaptureAsync).mockImplementation(async (_file, args) => {
        source = args[2];
        if (failure === 'throw') {
          throw new Error('copy transport failed');
        }
        return { exitCode: 1, stderr: 'copy refused', stdout: '' };
      });
      await expect(
        backend.create({ ...spec, services: [{ image: 'db:1', name: 'db' }] })
      ).rejects.toThrow(/copy/);
      expect(execShellAsync).toHaveBeenLastCalledWith(
        "docker rm -f 'workspace-nonroot'",
        expect.anything()
      );
      expect(vi.mocked(execShellAsync).mock.calls.some(([cmd]) => cmd.includes('-svc-db'))).toBe(
        false
      );
      await expect(fs.stat(source)).rejects.toThrow();
    }
  );

  it('keeps daemon extraction and assigns archive and file imports to the configured container user', async () => {
    await backend.copyIn(handle, '/host/empty.tar', '/workspace');
    expect(execShellAsync).toHaveBeenLastCalledWith(
      "docker cp -a - 'workspace-nonroot:/workspace' < '/host/empty.tar'",
      expect.anything()
    );
    expect(await backend.copyFileIn(handle, '/host/binary', '/workspace/binary')).toEqual(ok);
    expect(spawnCaptureAsync).toHaveBeenLastCalledWith(
      'docker',
      ['cp', '-a', '/host/binary', 'workspace-nonroot:/workspace/binary'],
      expect.anything()
    );
  });

  it('propagates archive failures and returns file-copy errors without a privileged repair exec', async () => {
    vi.mocked(execShellAsync).mockRejectedValueOnce(new Error('archive refused'));
    await expect(backend.copyIn(handle, '/host/bad.tar', '/workspace')).rejects.toThrow(
      'archive refused'
    );
    const error = { exitCode: 1, stderr: 'file refused', stdout: '' };
    vi.mocked(spawnCaptureAsync).mockResolvedValueOnce(error);
    expect(await backend.copyFileIn(handle, '/host/missing', '/workspace/binary')).toEqual(error);
    expect(vi.mocked(execShellAsync).mock.calls).toHaveLength(1);
  });
});
