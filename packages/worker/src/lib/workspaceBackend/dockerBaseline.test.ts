import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execShellAsync, spawnCaptureAsync } from '../execUtils.js';
import { assertDockerDiskLimit, baselineRules, dockerWorkspaceBackend } from './docker.js';
import type { WorkspaceContainerSpec } from './types.js';

vi.mock('../execUtils.js', async (original) => ({
  ...(await original<typeof import('../execUtils.js')>()),
  execShellAsync: vi.fn(),
  spawnCaptureAsync: vi.fn(),
}));

const spec: WorkspaceContainerSpec = {
  baselineAllow: [{ host: 'git.internal' }],
  cpus: 1,
  dns: ['10.0.0.53'],
  image: 'node:24-alpine',
  memory: '1g',
  name: 'workspace-baseline',
  pidsLimit: 32,
  reachWorker: true,
  services: [{ image: 'postgres:18', name: 'db' }],
};
const allow = [
  { ip: '10.0.0.5', port: 8790 },
  { ip: '10.1.0.8' },
  { ip: '10.0.0.53', port: 53, protocol: 'udp' as const },
  { ip: '10.0.0.53', port: 53, protocol: 'tcp' as const },
];
function report(rules = allow) {
  const expected = baselineRules(rules, []);
  return [
    'v4:',
    '-P OUTPUT ACCEPT',
    '-A OUTPUT -j ASW_BASELINE',
    ...expected.v4.map((r) => `-A ASW_BASELINE ${r}`),
    'v6:',
    '-P OUTPUT ACCEPT',
    '-A OUTPUT -j ASW_BASELINE',
    ...expected.v6.map((r) => `-A ASW_BASELINE ${r}`),
    'v6disabled=0',
  ].join('\n');
}

beforeEach(() => {
  vi.stubEnv('WORKSPACE_BACKEND', 'docker');
  vi.stubEnv('WORKSPACE_BLOCK_PRIVATE_EGRESS', 'true');
  vi.stubEnv('WORKSPACE_BLOCK_METADATA', 'true');
  vi.stubEnv('WORKSPACE_PRIVATE_EGRESS_ALLOW', '');
  vi.stubEnv('WORKSPACE_DISK_LIMIT', '');
  vi.stubEnv('HARNESS_MODEL_PROXY_PORT', '8790');
  vi.stubEnv('HARNESS_MODEL_PROXY_URL', 'http://10.0.0.5:8790');
  vi.stubEnv('REGISTRY_PROXY_PORT', '');
  vi.stubEnv('EGRESS_PROXY_PORT', '');
  vi.mocked(execShellAsync).mockImplementation(async (cmd) =>
    cmd.includes('PPid:') ? '42\n' : cmd.includes('--network container:') ? report() : ''
  );
  vi.mocked(spawnCaptureAsync).mockImplementation(async (_bin, args) => ({
    exitCode: 0,
    stderr: '',
    stdout: args.includes('inspect')
      ? '[]'
      : args.includes('getent')
        ? '10.1.0.8 git.internal'
        : '',
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe('Docker baseline create', () => {
  it('applies the runtime to workspaces and their services, not trusted helpers or delivery', async () => {
    vi.stubEnv('WORKSPACE_RUNTIME', 'runsc-host');
    await dockerWorkspaceBackend().create(spec);
    let cmds = vi.mocked(execShellAsync).mock.calls.map(([cmd]) => cmd);
    expect(cmds[0]).toContain("'--runtime=runsc-host'");
    expect(cmds.find((cmd) => cmd.includes('workspace-baseline-svc-db'))).toContain(
      '--runtime=runsc-host'
    );
    expect(cmds.find((cmd) => cmd.includes('--network container:'))).not.toContain('--runtime');
    vi.mocked(execShellAsync).mockClear();
    await dockerWorkspaceBackend().create({ ...spec, services: [], trusted: true });
    cmds = vi.mocked(execShellAsync).mock.calls.map(([cmd]) => cmd);
    expect(cmds[0]).not.toContain('--runtime');
  });
  it('verifies the helper before starting services and adds the opt-in storage cap', async () => {
    vi.stubEnv('WORKSPACE_DISK_LIMIT', '20g');
    await dockerWorkspaceBackend().create(spec);
    const cmds = vi.mocked(execShellAsync).mock.calls.map(([cmd]) => cmd);
    expect(cmds[0]).toContain("--storage-opt 'size=20g'");
    expect(cmds.findIndex((cmd) => cmd.includes('--network container:'))).toBeLessThan(
      cmds.findIndex((cmd) => cmd.includes('workspace-baseline-svc-db'))
    );
    expect(cmds.join()).not.toContain('cat >> /etc/hosts');
  });

  it.each(['throw', 'bad report'])(
    'removes the workspace and does not start services on %s',
    async (failure) => {
      vi.mocked(execShellAsync).mockImplementation(async (cmd) => {
        if (cmd.includes('--network container:')) {
          if (failure === 'throw') {
            throw new Error('helper failed');
          }
          return '';
        }
        return cmd.includes('PPid:') ? '42\n' : '';
      });
      await expect(dockerWorkspaceBackend().create(spec)).rejects.toThrow();
      const cmds = vi.mocked(execShellAsync).mock.calls.map(([cmd]) => cmd);
      expect(cmds.at(-1)).toBe("docker rm -f 'workspace-baseline'");
      expect(cmds.join()).not.toContain('workspace-baseline-svc-db');
    }
  );

  it('omits helper and quota only when both controls and quota are off', async () => {
    vi.stubEnv('WORKSPACE_BLOCK_PRIVATE_EGRESS', 'false');
    vi.stubEnv('WORKSPACE_BLOCK_METADATA', 'false');
    await dockerWorkspaceBackend().create(spec);
    expect(vi.mocked(execShellAsync).mock.calls[0]?.[0]).not.toContain('--storage-opt');
    expect(
      vi.mocked(execShellAsync).mock.calls.some(([cmd]) => cmd.includes('--network container:'))
    ).toBe(false);
  });

  it('retains a verified metadata-only baseline when private blocking is disabled', async () => {
    vi.stubEnv('WORKSPACE_BLOCK_PRIVATE_EGRESS', 'false');
    const rules = baselineRules([], [], false, true);
    const output = [
      'v4:',
      '-P OUTPUT ACCEPT',
      '-A OUTPUT -j ASW_BASELINE',
      ...rules.v4.map((r) => `-A ASW_BASELINE ${r}`),
      'v6:',
      '-P OUTPUT ACCEPT',
      '-A OUTPUT -j ASW_BASELINE',
      ...rules.v6.map((r) => `-A ASW_BASELINE ${r}`),
      'v6disabled=0',
    ].join('\n');
    vi.mocked(execShellAsync).mockImplementation(async (cmd) =>
      cmd.includes('PPid:') ? '42\n' : cmd.includes('--network container:') ? output : ''
    );
    await dockerWorkspaceBackend().create(spec);
    const cmd = vi
      .mocked(execShellAsync)
      .mock.calls.find(([cmd]) => cmd.includes('--network container:'))?.[0];
    expect(cmd).toContain('169.254.169.254');
    expect(cmd).not.toContain('10.0.0.0/8');
    expect(vi.mocked(spawnCaptureAsync).mock.calls.filter(([, args]) => args[0] !== 'cp')).toEqual(
      []
    );
  });

  it('trusts only the worker-added alias and omits public destination ACCEPT rules', async () => {
    vi.stubEnv('HARNESS_MODEL_PROXY_URL', 'http://host.docker.internal:8790');
    vi.mocked(spawnCaptureAsync).mockImplementation(async (_bin, args) => ({
      exitCode: 0,
      stderr: '',
      stdout: args.includes('inspect')
        ? '["host.docker.internal:host-gateway"]'
        : args.includes('getent')
          ? '8.8.8.8 git.internal'
          : '10.0.0.5 host.docker.internal',
    }));
    vi.mocked(execShellAsync).mockImplementation(async (cmd) =>
      cmd.includes('PPid:')
        ? '42\n'
        : cmd.includes('--network container:')
          ? report(allow.filter((e) => e.ip !== '10.1.0.8'))
          : ''
    );
    await dockerWorkspaceBackend().create(spec);
    const cmd = vi
      .mocked(execShellAsync)
      .mock.calls.find(([cmd]) => cmd.includes('--network container:'))?.[0];
    expect(cmd).toContain('-d 10.0.0.5 -p tcp');
    expect(cmd).not.toContain('-d 8.8.8.8');
    expect(
      vi
        .mocked(spawnCaptureAsync)
        .mock.calls.some(
          ([, args]) => args.includes('getent') && args.includes('host.docker.internal')
        )
    ).toBe(false);
  });

  it('fails unresolved proxies but warns and skips an unresolved git host', async () => {
    vi.mocked(spawnCaptureAsync).mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(execShellAsync).mockImplementation(async (cmd) =>
      cmd.includes('PPid:')
        ? '42\n'
        : cmd.includes('--network container:')
          ? report(allow.filter((e) => e.ip !== '10.1.0.8'))
          : ''
    );
    await dockerWorkspaceBackend().create(spec);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('skipping baseline host git.internal')
    );
    vi.stubEnv('HARNESS_MODEL_PROXY_URL', 'http://missing.internal:8790');
    await expect(dockerWorkspaceBackend().create(spec)).rejects.toThrow('resolved to no address');
  });
});

describe('Docker quota startup probe', () => {
  it('does not run when unset or on Kubernetes', async () => {
    await assertDockerDiskLimit();
    vi.stubEnv('WORKSPACE_BACKEND', 'kubernetes');
    vi.stubEnv('WORKSPACE_DISK_LIMIT', '20g');
    await assertDockerDiskLimit();
    expect(execShellAsync).not.toHaveBeenCalled();
  });

  it.each(['overlay2', 'devicemapper', 'btrfs', 'zfs'])(
    'probes storage-opt with the helper image on %s and refuses probe failures',
    async (driver) => {
      vi.stubEnv('WORKSPACE_DISK_LIMIT', '20g');
      vi.mocked(execShellAsync).mockImplementation(async (cmd) =>
        cmd.startsWith('docker inspect') ? `${driver}\n` : ''
      );
      await assertDockerDiskLimit();
      expect(execShellAsync).toHaveBeenCalledWith(
        `docker run --rm --storage-opt 'size=20g' -- '${resolveWorkspaceInfra().metadataBlockImage}' true`,
        expect.anything()
      );
      vi.mocked(execShellAsync).mockRejectedValue(new Error('unsupported storage'));
      await expect(assertDockerDiskLimit()).rejects.toThrow('overlay2 requires XFS with pquota');
    }
  );

  it('fails closed on inspection errors and removes the probe', async () => {
    vi.stubEnv('WORKSPACE_DISK_LIMIT', '1g');
    vi.mocked(execShellAsync).mockImplementation(async (cmd) => {
      if (cmd.startsWith('docker inspect')) {
        throw new Error('inspect failed');
      }
      return '';
    });
    await expect(assertDockerDiskLimit()).rejects.toThrow('inspect failed');
    expect(vi.mocked(execShellAsync).mock.calls.at(-1)?.[0]).toMatch(
      /^docker rm -f workspace-disk-probe-/
    );
  });

  it.each(['overlayfs', ''])(
    'rejects driver %j even when Docker accepts storage-opt, and removes the probe',
    async (driver) => {
      vi.stubEnv('WORKSPACE_DISK_LIMIT', '1g');
      vi.mocked(execShellAsync).mockImplementation(async (cmd) =>
        cmd.startsWith('docker inspect') ? driver : ''
      );
      await expect(assertDockerDiskLimit()).rejects.toThrow('size may be silently ignored');
      expect(vi.mocked(execShellAsync).mock.calls.at(-1)?.[0]).toMatch(
        /^docker rm -f workspace-disk-probe-/
      );
    }
  );
});
