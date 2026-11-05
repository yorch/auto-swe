import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execShellAsync, spawnCaptureAsync, spawnWithStdinAsync, lookup } = vi.hoisted(() => ({
  execShellAsync: vi.fn(),
  lookup: vi.fn(),
  spawnCaptureAsync: vi.fn(),
  spawnWithStdinAsync: vi.fn(),
}));
vi.mock('../execUtils.js', () => ({
  execShellAsync,
  spawnCaptureAsync,
  spawnToFileCapped: vi.fn(),
  spawnWithStdinAsync,
}));
vi.mock('node:dns/promises', () => ({ default: { lookup } }));

import { dockerWorkspaceBackend, resolveEgressTargets, resolveInWorkspace } from './docker.js';

const LOCKED =
  'v4:\n-P OUTPUT DROP\n-P INPUT DROP\nv6:\n-P OUTPUT DROP\n-P INPUT DROP\nv6disabled=0\n';
const handle = { id: 'workspace-abc', keeperPid: 7 };
const ok = (stdout = '') => ({ exitCode: 0, stderr: '', stdout });

const HOSTS_FILE = '127.0.0.1\tlocalhost\n172.17.0.1\thost.docker.internal\n';
let hostsFile = HOSTS_FILE;
let extraHosts = '["host.docker.internal:host-gateway"]';
/** getent answers by name; a missing key is "not found" (exit 2). */
let getent: Record<string, string> = {};

beforeEach(() => {
  vi.clearAllMocks();
  hostsFile = HOSTS_FILE;
  extraHosts = '["host.docker.internal:host-gateway"]';
  getent = { 'git.example.com': '203.0.113.7      STREAM git.example.com\n' };
  spawnCaptureAsync.mockImplementation(async (_f: string, args: string[]) => {
    if (args[0] === 'inspect') {
      return ok(`${extraHosts}\n`);
    }
    if (args.includes('cat')) {
      return ok(hostsFile);
    }
    if (args.includes('getent')) {
      const answer = getent[args[args.length - 1] ?? ''];
      return answer === undefined ? { exitCode: 2, stderr: '', stdout: '' } : ok(answer);
    }
    return ok();
  });
  spawnWithStdinAsync.mockResolvedValue(ok());
  lookup.mockResolvedValue([{ address: '198.51.100.250', family: 4 }]);
});

describe('lockEgress', () => {
  it('runs one NET_ADMIN helper in the workspace namespace and accepts a DROP read-back', async () => {
    execShellAsync.mockResolvedValue(LOCKED);
    await dockerWorkspaceBackend().lockEgress(handle, [{ host: '203.0.113.7', port: 443 }]);
    expect(execShellAsync).toHaveBeenCalledTimes(1);
    const cmd = String(execShellAsync.mock.calls[0]?.[0]);
    expect(cmd).toContain('--network container:workspace-abc');
    expect(cmd).toContain('--cap-add=NET_ADMIN');
    // An IP literal needs no hosts line.
    expect(spawnWithStdinAsync).not.toHaveBeenCalled();
  });

  it('resolves names in the workspace, pins them as root in the workspace, then locks', async () => {
    execShellAsync.mockResolvedValue(LOCKED);
    await dockerWorkspaceBackend().lockEgress(handle, [{ host: 'git.example.com', port: 443 }]);
    // Resolved inside the workspace, as root, never by the worker.
    expect(lookup).not.toHaveBeenCalled();
    expect(spawnCaptureAsync).toHaveBeenCalledWith(
      'docker',
      ['exec', '-u', 'root', 'workspace-abc', 'getent', 'ahosts', 'git.example.com'],
      expect.anything()
    );
    const [file, args, stdin] = spawnWithStdinAsync.mock.calls[0] ?? [];
    expect(file).toBe('docker');
    expect(args).toEqual([
      'exec',
      '-i',
      '-u',
      'root',
      'workspace-abc',
      'sh',
      '-c',
      'cat >> /etc/hosts',
    ]);
    expect(stdin).toBe('203.0.113.7\tgit.example.com\n');
    const cmd = String(execShellAsync.mock.calls[0]?.[0]);
    expect(cmd).toContain('203.0.113.7');
    expect(cmd).not.toContain('git.example.com');
    // The hosts file is written before the helper locks anything.
    expect(spawnWithStdinAsync.mock.invocationCallOrder[0]).toBeLessThan(
      execShellAsync.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('refuses a name that resolves to a forbidden address before touching the workspace', async () => {
    getent['git.example.com'] = '169.254.169.254 STREAM git.example.com\n';
    await expect(
      dockerWorkspaceBackend().lockEgress(handle, [{ host: 'git.example.com' }])
    ).rejects.toThrow(/refused address/);
    expect(spawnWithStdinAsync).not.toHaveBeenCalled();
    expect(execShellAsync).not.toHaveBeenCalled();
  });

  it('fails closed when /etc/hosts cannot be written', async () => {
    getent['git.example.com'] = '203.0.113.7 STREAM git.example.com\n';
    spawnWithStdinAsync.mockResolvedValue({ exitCode: 1, stderr: 'ro', stdout: '' });
    await expect(
      dockerWorkspaceBackend().lockEgress(handle, [{ host: 'git.example.com' }])
    ).rejects.toThrow(/cannot write/);
    expect(execShellAsync).not.toHaveBeenCalled();
  });

  it('resolves a name once for two ports, with one pinned line and matching rules', async () => {
    execShellAsync.mockResolvedValue(LOCKED);
    await dockerWorkspaceBackend().lockEgress(handle, [
      { host: 'git.example.com', port: 443 },
      { host: 'git.example.com', port: 22 },
    ]);
    const lookups = spawnCaptureAsync.mock.calls.filter((c) =>
      (c[1] as string[]).includes('getent')
    );
    expect(lookups).toHaveLength(1);
    expect(spawnWithStdinAsync.mock.calls[0]?.[2]).toBe('203.0.113.7\tgit.example.com\n');
    const cmd = String(execShellAsync.mock.calls[0]?.[0]);
    expect(cmd).toMatch(/allow_ip \S*203\.0\.113\.7\S* \S*443/);
    expect(cmd).toMatch(/allow_ip \S*203\.0\.113\.7\S* \S*22/);
  });

  it('throws when the name cannot be resolved by any means', async () => {
    await expect(
      dockerWorkspaceBackend().lockEgress(handle, [{ host: 'nx.example.com' }])
    ).rejects.toThrow(/no address/);
    expect(execShellAsync).not.toHaveBeenCalled();
  });

  it('honours the worker alias from the hosts file only when --add-host recorded it', async () => {
    execShellAsync.mockResolvedValue(LOCKED);
    await dockerWorkspaceBackend().lockEgress(handle, [
      { host: 'host.docker.internal', port: 8791 },
    ]);
    expect(spawnWithStdinAsync).not.toHaveBeenCalled();
    expect(String(execShellAsync.mock.calls[0]?.[0])).toMatch(
      /allow_ip \S*172\.17\.0\.1\S* \S*8791/
    );
    // Not recorded in the container spec: the same file line is not trusted, so it is refused.
    extraHosts = 'null';
    await expect(
      dockerWorkspaceBackend().lockEgress(handle, [{ host: 'host.docker.internal' }])
    ).rejects.toThrow(/already maps/);
  });

  it('uses the first alias line, so a line planted after it widens nothing', async () => {
    execShellAsync.mockResolvedValue(LOCKED);
    hostsFile += '203.0.113.66\thost.docker.internal\n';
    await dockerWorkspaceBackend().lockEgress(handle, [{ host: 'host.docker.internal' }]);
    const cmd = String(execShellAsync.mock.calls[0]?.[0]);
    expect(cmd).toContain('172.17.0.1');
    expect(cmd).not.toContain('203.0.113.66');
  });

  it('does not honour a planted line for any other name', async () => {
    hostsFile += '203.0.113.66\tgit.example.com\n';
    await expect(
      dockerWorkspaceBackend().lockEgress(handle, [{ host: 'git.example.com', port: 443 }])
    ).rejects.toThrow(/already maps/);
    expect(execShellAsync).not.toHaveBeenCalled();
  });

  it('ignores the lock options: the lock is the same in both modes', async () => {
    execShellAsync.mockResolvedValue(LOCKED);
    await dockerWorkspaceBackend().lockEgress(handle, [], { mode: 'restricted' });
    expect(execShellAsync).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the helper exits non-zero', async () => {
    execShellAsync.mockRejectedValue(new Error('egress lock: helper image has no iptables'));
    await expect(dockerWorkspaceBackend().lockEgress(handle, [])).rejects.toThrow(/no iptables/);
  });

  it('fails closed when the read-back does not show a DROP policy', async () => {
    execShellAsync.mockResolvedValue('v4:\n-P OUTPUT ACCEPT\n-P INPUT DROP\nv6:\n-P OUTPUT DROP\n');
    await expect(dockerWorkspaceBackend().lockEgress(handle, [])).rejects.toThrow(/IPv4/);
    execShellAsync.mockResolvedValue('v4:\n-P OUTPUT DROP\n-P INPUT ACCEPT\nv6:\n-P OUTPUT DROP\n');
    await expect(dockerWorkspaceBackend().lockEgress(handle, [])).rejects.toThrow(/INPUT/);
  });

  it('refuses an invalid entry before any docker command runs', async () => {
    await expect(
      dockerWorkspaceBackend().lockEgress(handle, [{ host: 'x; curl evil' }])
    ).rejects.toThrow(/invalid host/);
    expect(execShellAsync).not.toHaveBeenCalled();
    expect(spawnWithStdinAsync).not.toHaveBeenCalled();
  });
});

describe('resolveInWorkspace', () => {
  beforeEach(() => spawnCaptureAsync.mockReset());
  const run = (...codes: Array<{ exitCode: number; stdout?: string; stderr?: string }>) => {
    spawnCaptureAsync.mockReset();
    for (const c of codes) {
      spawnCaptureAsync.mockResolvedValueOnce({ stderr: '', stdout: '', ...c });
    }
  };
  const argvOf = (n: number) => spawnCaptureAsync.mock.calls[n]?.[1] as string[];

  it('asks getent ahosts inside the workspace as root, the name as one argv element', async () => {
    run({
      exitCode: 0,
      stdout:
        '10.0.0.5        STREAM git.example.com\n10.0.0.5        DGRAM  \n10.0.0.5        RAW    \n',
    });
    await expect(resolveInWorkspace('workspace-ab', 'git.example.com', new Map())).resolves.toEqual(
      ['10.0.0.5']
    );
    expect(argvOf(0)).toEqual([
      'exec',
      '-u',
      'root',
      'workspace-ab',
      'getent',
      'ahosts',
      'git.example.com',
    ]);
  });

  it('falls back to getent hosts when ahosts is unsupported, unmapping v4-mapped answers', async () => {
    run(
      { exitCode: 1, stderr: 'Unknown database: ahosts' },
      { exitCode: 0, stdout: '::ffff:10.0.0.6 a.example.com\n' }
    );
    await expect(resolveInWorkspace('w', 'a.example.com', new Map())).resolves.toEqual([
      '10.0.0.6',
    ]);
    expect(argvOf(1)[5]).toBe('hosts');
  });

  it('treats an unknown name as no address, so the lock throws', async () => {
    run({ exitCode: 2 }, { exitCode: 2 });
    await expect(resolveInWorkspace('w', 'nx.example.com', new Map())).resolves.toEqual([]);
    run({ exitCode: 2 }, { exitCode: 2 });
    await expect(
      resolveEgressTargets([{ host: 'nx.example.com' }], (h) =>
        resolveInWorkspace('w', h, new Map())
      )
    ).rejects.toThrow(/no address/);
  });

  it('falls back to the worker lookup when getent is missing, except for the worker own name', async () => {
    const lookup = vi.fn(async () => ['203.0.113.9']);
    run({ exitCode: 127, stderr: 'executable file not found in $PATH' });
    await expect(resolveInWorkspace('w', 'git.example.com', new Map(), lookup)).resolves.toEqual([
      '203.0.113.9',
    ]);
    run({ exitCode: 127, stderr: 'executable file not found in $PATH' });
    await expect(resolveInWorkspace('w', os.hostname(), new Map(), lookup)).rejects.toThrow(
      /no getent/
    );
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('refuses a name the workspace hosts file already maps', async () => {
    run({ exitCode: 0, stdout: '203.0.113.66 STREAM git.example.com\n' });
    await expect(
      resolveInWorkspace('w', 'git.example.com', new Map([['git.example.com', ['203.0.113.66']]]))
    ).rejects.toThrow(/already maps/);
    expect(spawnCaptureAsync).not.toHaveBeenCalled();
  });

  it('a forbidden in-workspace answer is refused by the caller', async () => {
    run({ exitCode: 0, stdout: '169.254.169.254 STREAM x.example.com\n' });
    await expect(
      resolveEgressTargets([{ host: 'x.example.com' }], (h) =>
        resolveInWorkspace('w', h, new Map())
      )
    ).rejects.toThrow(/refused address/);
  });
});
