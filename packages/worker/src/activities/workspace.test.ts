import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/execUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/execUtils.js')>();
  return {
    ...actual,
    execShellAsync: vi.fn(async () => ''),
    spawnWithStdinAsync: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
  };
});

// Mock the workflow-defaults resolver so `createWorkspace` doesn't hit a real
// DB — it now reads container caps + the default base image from here.
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: vi.fn(async () => ({
    workspaceCpus: 2,
    workspaceImage: 'node:24-alpine',
    workspaceMemory: '4g',
    workspacePidsLimit: 512,
  })),
}));

// Backs the config registry: no rows means the metadata-blocking settings
// resolve to their definition defaults (blocking on, alpine:3.20).
vi.mock('@auto-swe/shared/db', () => ({
  prisma: { configSetting: { findMany: vi.fn(async () => []) } },
}));

// `createWorkspace` resolves settings through the activity's request context,
// which needs a Temporal activity to exist; outside one it returns an empty ctx.
vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn(async () => ({})),
}));

import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { execShellAsync, spawnWithStdinAsync } from '../lib/execUtils.js';
import {
  authedGitScript,
  buildMetadataBlockArgs,
  cloneDependencyRepos,
  createWorkspace,
  fetchBranchesSubcommand,
  killStrayProcessesScript,
  killTaggedProcessesScript,
  MAX_DEPENDENCY_CHECKOUTS,
  safeDepDirName,
  shellQuote,
  splitCloneCredential,
} from './workspace.js';

describe('shellQuote', () => {
  it('wraps a plain string', () => expect(shellQuote('abc')).toBe("'abc'"));
  it('escapes an embedded single quote', () => expect(shellQuote("it's")).toBe("'it'\\''s'"));
  it('escapes consecutive single quotes', () => expect(shellQuote("''")).toBe("''\\'''\\'''"));
  it('neutralizes command substitution', () =>
    expect(shellQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'"));
  it('neutralizes backticks', () => expect(shellQuote('`id`')).toBe("'`id`'"));
  it('neutralizes separators and chaining', () =>
    expect(shellQuote('a; b && c | d')).toBe("'a; b && c | d'"));
  it('preserves newlines inside the quotes', () => expect(shellQuote('a\nb')).toBe("'a\nb'"));
  it('quotes the empty string', () => expect(shellQuote('')).toBe("''"));

  it.each([
    "it's a 'test'",
    '$(touch /tmp/pwned)',
    '`touch /tmp/pwned`',
    'a; rm -rf / && echo done',
    'line1\nline2',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${PATH} is intentional adversarial input
    '$HOME ${PATH} \\backslash',
  ])('round-trips %j through sh -c printf', (input) => {
    const out = execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(input)}`], {
      encoding: 'utf8',
    });
    expect(out).toBe(input);
  });
});

describe('buildMetadataBlockArgs', () => {
  it('targets the workspace container network namespace, adds NET_ADMIN, and is self-removing', () => {
    const cmd = buildMetadataBlockArgs('workspace-abc123', 'alpine:3.20');
    expect(cmd).toContain('--rm');
    expect(cmd).toContain('--network container:workspace-abc123');
    expect(cmd).toContain('--cap-add=NET_ADMIN');
  });

  it('installs blackhole routes for all three cloud metadata addresses', () => {
    const cmd = buildMetadataBlockArgs('workspace-abc123', 'alpine:3.20');
    expect(cmd).toContain('blackhole 169.254.169.254/32'); // AWS/GCP/Azure IMDS
    expect(cmd).toContain('blackhole 169.254.170.2/32'); // ECS task metadata
    expect(cmd).toContain('blackhole fd00:ec2::254/128'); // IPv6 IMDS
  });

  it('verifies a blackhole route actually landed and exits non-zero otherwise', () => {
    // Guards against a silent no-op: if the runtime's `ip` lacks blackhole
    // support the adds fail quietly, so the sidecar must fail loudly (non-zero
    // exit → caller logs a warning) rather than report false success.
    const cmd = buildMetadataBlockArgs('workspace-abc123', 'alpine:3.20');
    expect(cmd).toContain('grep -q blackhole');
    expect(cmd).toContain('exit 1');
    // The IPv4 IMDS adds must NOT be individually `|| true`'d (that would mask
    // the failure the verify step is meant to catch).
    expect(cmd).not.toContain('169.254.169.254/32 2>/dev/null || true');
  });

  it('shell-quotes the sidecar image argument', () => {
    const cmd = buildMetadataBlockArgs('workspace-abc123', 'alpine:3.20');
    expect(cmd).toContain(shellQuote('alpine:3.20'));
  });

  it('does not grant the sidecar capabilities beyond NET_ADMIN', () => {
    const cmd = buildMetadataBlockArgs('workspace-abc123', 'alpine:3.20');
    expect(cmd).not.toContain('--cap-drop');
  });
});

describe('createWorkspace metadata-IP egress block (execShellAsync mocked — no Docker daemon here)', () => {
  beforeEach(() => {
    vi.mocked(execShellAsync).mockReset();
    vi.mocked(execShellAsync).mockImplementation(async () => '');
  });

  it('starts the workspace unprivileged (--cap-drop=ALL, no --cap-add) and runs a distinct metadata-block sidecar', async () => {
    const ws = await createWorkspace('https://github.com/acme/repo.git', 'auto/TICKET-1', 'main');
    const commands = vi.mocked(execShellAsync).mock.calls.map((call) => call[0] as string);

    const startCmd = commands.find((c) => c.includes('docker run -d --name'));
    expect(startCmd).toBeDefined();
    expect(startCmd).toContain('--cap-drop=ALL');
    expect(startCmd).not.toContain('--cap-add');

    const metadataCmd = commands.find((c) => c.includes('--network container:'));
    expect(metadataCmd).toBeDefined();
    expect(metadataCmd).toContain('--cap-add=NET_ADMIN');
    expect(metadataCmd).not.toContain('--cap-drop=ALL');
    expect(metadataCmd).not.toBe(startCmd);

    // Both commands must reference the same container name — the sidecar
    // joins *this* workspace's netns, not some other container's.
    const nameMatch = startCmd?.match(/--name (\S+)/);
    expect(nameMatch?.[1]).toBeDefined();
    expect(metadataCmd).toContain(`--network container:${nameMatch?.[1]}`);

    await ws.destroy();
  });

  it('applies the resolved workspace caps + default image from workflow defaults', async () => {
    vi.mocked(resolveWorkflowDefaults).mockResolvedValueOnce({
      workspaceCpus: 6,
      workspaceImage: 'custom/base:1.2',
      workspaceMemory: '9g',
      workspacePidsLimit: 999,
    } as never);

    const ws = await createWorkspace('https://github.com/acme/repo.git', 'auto/TICKET-1', 'main');
    const commands = vi.mocked(execShellAsync).mock.calls.map((call) => call[0] as string);

    const startCmd = commands.find((c) => c.includes('docker run -d --name'));
    // The memory string is shell-quoted (defense-in-depth); numeric caps are not.
    expect(startCmd).toContain(`--memory=${shellQuote('9g')}`);
    expect(startCmd).toContain('--cpus=6');
    expect(startCmd).toContain('--pids-limit=999');
    // No explicit image passed → the resolved config image is used.
    expect(startCmd).toContain(shellQuote('custom/base:1.2'));

    await ws.destroy();
  });

  it('honours an explicit image argument over the resolved default image', async () => {
    const ws = await createWorkspace(
      'https://github.com/acme/repo.git',
      'auto/TICKET-1',
      'main',
      'ghcr.io/acme/executor:9'
    );
    const commands = vi.mocked(execShellAsync).mock.calls.map((call) => call[0] as string);
    const startCmd = commands.find((c) => c.includes('docker run -d --name'));
    expect(startCmd).toContain(shellQuote('ghcr.io/acme/executor:9'));
    expect(startCmd).not.toContain(shellQuote('node:24-alpine'));

    await ws.destroy();
  });

  it('is best-effort: a failed metadata-block sidecar does not fail workspace creation', async () => {
    vi.mocked(execShellAsync).mockImplementation(async (cmd: string) => {
      if (cmd.includes('--network container:')) {
        throw new Error('sidecar boom');
      }
      return '';
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const ws = await createWorkspace('https://github.com/acme/repo.git', 'auto/TICKET-1', 'main');

    expect(ws.containerId).toMatch(/^workspace-/);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('metadata-IP egress block failed')
    );

    warnSpy.mockRestore();
    await ws.destroy();
  });
});

describe('createWorkspace clone credential handling (execShellAsync mocked)', () => {
  const AUTHED = 'https://x-access-token:ghp_secret@github.com/acme/repo.git';
  const CLEAN = 'https://github.com/acme/repo.git';
  const HEADER_B64 = Buffer.from('x-access-token:ghp_secret').toString('base64');
  // The clone runs inside `docker exec … sh -c '<script>'`, so a value that is
  // `shellQuote`d in the script appears re-escaped once more in the outer command.
  const Q = (v: string) => shellQuote(v).replace(/'/g, "'\\''");

  beforeEach(() => {
    vi.mocked(execShellAsync).mockReset();
    vi.mocked(execShellAsync).mockImplementation(async () => '');
  });

  const cloneCommands = () =>
    vi
      .mocked(execShellAsync)
      .mock.calls.map((call) => call[0] as string)
      .filter((c) => c.includes('git') && c.includes('clone'));

  it('clones with the clean URL, a per-call auth header, and `--` before the URL', async () => {
    const ws = await createWorkspace(AUTHED, 'auto/TICKET-1', 'main');
    const [cloneCmd] = cloneCommands();
    expect(cloneCmd).toBeDefined();
    // The raw token never appears on the command line…
    expect(cloneCmd).not.toContain('ghp_secret');
    expect(cloneCmd).not.toContain('x-access-token:');
    // …the credential travels as a per-call header instead…
    expect(cloneCmd).toContain('http.extraheader=');
    expect(cloneCmd).toContain(HEADER_B64);
    // …and option parsing is terminated before the (quoted) clean URL.
    expect(cloneCmd).toContain(`-- ${Q(CLEAN)} /workspace/target-repo`);
    expect(cloneCmd).toContain(`-b ${Q('main')}`);
    await ws.destroy();
  });

  it('terminates options with `--` on the pinned-SHA and existing-branch clone paths too', async () => {
    await createWorkspace(AUTHED, 'auto/T-1', 'main', undefined, 'deadbeef');
    await createWorkspace(AUTHED, 'auto/T-1', 'main', undefined, undefined, true);
    const cmds = cloneCommands();
    expect(cmds).toHaveLength(2);
    for (const c of cmds) {
      expect(c).toContain(`-- ${Q(CLEAN)} /workspace/target-repo`);
      expect(c).not.toContain('ghp_secret');
    }
    expect(cmds[1]).toContain(`-b ${Q('auto/T-1')}`);
  });

  it('redacts the token and its auth header from a clone failure and removes the container', async () => {
    vi.mocked(execShellAsync).mockImplementation(async (cmd: string) => {
      if (cmd.includes('clone')) {
        // Shape of a promisify(exec) rejection: the full command line in the
        // message, plus stdout/stderr/cmd own-properties.
        throw Object.assign(new Error(`Command failed: ${cmd}\nfatal: auth failed`), {
          cmd,
          stderr: `fatal: unable to access with ${HEADER_B64} / ghp_secret`,
          stdout: '',
        });
      }
      return '';
    });

    let caught: (Error & { cmd?: string; stderr?: string }) | undefined;
    try {
      await createWorkspace(AUTHED, 'auto/TICKET-1', 'main');
    } catch (err) {
      caught = err as Error & { cmd?: string; stderr?: string };
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toContain('Command failed');
    expect(caught?.message).toContain('***');
    for (const field of [caught?.message, caught?.cmd, caught?.stderr]) {
      expect(field).not.toContain('ghp_secret');
      expect(field).not.toContain(HEADER_B64);
    }

    const commands = vi.mocked(execShellAsync).mock.calls.map((call) => call[0] as string);
    expect(commands.some((c) => c.startsWith('docker rm -f workspace-'))).toBe(true);
  });

  it('redacts the auth header from a failed authenticated push', async () => {
    const ws = await createWorkspace(AUTHED, 'auto/TICKET-1', 'main');
    vi.mocked(execShellAsync).mockImplementation(async (cmd: string) => {
      if (cmd.includes('push')) {
        throw Object.assign(new Error(`Command failed: ${cmd}`), { cmd });
      }
      return '';
    });
    await expect(ws.gitAuthed(`push origin ${shellQuote('auto/TICKET-1')}`)).rejects.toSatisfy(
      (err: Error & { cmd?: string }) =>
        err.message.includes('***') &&
        !err.message.includes(HEADER_B64) &&
        !err.message.includes('ghp_secret') &&
        !(err.cmd ?? '').includes(HEADER_B64)
    );
  });

  it('runs gitAuthed hardened: config rewritten, hooks off, push to the scrubbed URL', async () => {
    const ws = await createWorkspace(AUTHED, 'auto/TICKET-1', 'main');
    vi.mocked(execShellAsync).mockClear();
    await ws.gitAuthed(`push origin ${shellQuote('auto/TICKET-1')}`);
    const [cmd] = vi.mocked(execShellAsync).mock.calls.map((c) => c[0] as string);
    expect(cmd).toContain('mv -f .git/config.auto-swe-tmp .git/config');
    expect(cmd).toContain('-c core.hooksPath=/dev/null');
    expect(cmd).toContain('GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null');
    expect(cmd).toContain(`push --no-verify ${Q(CLEAN)} ${Q('auto/TICKET-1')}`);
    expect(cmd).not.toContain('push origin');
    expect(cmd.indexOf('mv -f .git/config')).toBeLessThan(cmd.indexOf('push --no-verify'));
    // Stray processes die first, in the same exec as the rewrite and the call.
    expect(cmd.indexOf('asw_sweep KILL')).toBeGreaterThanOrEqual(0);
    expect(cmd.indexOf('asw_sweep KILL')).toBeLessThan(cmd.indexOf('mv -f .git/config'));
    // The repository is pinned before the credential-bearing call.
    expect(cmd.indexOf('export GIT_DIR GIT_WORK_TREE')).toBeLessThan(
      cmd.indexOf('push --no-verify')
    );
  });

  it('kills the timed-out command inside the container by its exec tag', async () => {
    const ws = await createWorkspace(AUTHED, 'auto/TICKET-1', 'main');
    vi.mocked(execShellAsync).mockImplementation(async (cmd: string, opts) => {
      if (cmd.includes('yarn test')) {
        await opts?.onTimeout?.();
        throw Object.assign(new Error('Command failed: timed out'), { killed: true });
      }
      return '';
    });
    await expect(ws.exec('yarn test', { timeoutMs: 1000 })).rejects.toThrow('timed out');

    const cmds = vi.mocked(execShellAsync).mock.calls.map((c) => c[0] as string);
    const run = cmds.find((c) => c.includes('yarn test')) ?? '';
    const tag = /-e AUTO_SWE_EXEC_ID=([0-9a-f]{16}) /.exec(run)?.[1];
    expect(tag).toBeDefined();
    const kill = cmds.find((c) => c.includes('asw_kill')) ?? '';
    expect(kill).toContain(`docker exec ${ws.containerId} sh -c`);
    expect(kill).toContain(`AUTO_SWE_EXEC_ID=${tag}`);
  });

  it('removes the container by name when `docker run` itself fails', async () => {
    vi.mocked(execShellAsync).mockImplementation(async (cmd: string) => {
      if (cmd.startsWith('docker run -d')) {
        throw new Error('Command failed: docker run timed out');
      }
      return '';
    });
    await expect(createWorkspace(AUTHED, 'auto/TICKET-1', 'main')).rejects.toThrow('docker run');
    const cmds = vi.mocked(execShellAsync).mock.calls.map((c) => c[0] as string);
    const name = /--name (workspace-[0-9a-f]+)/.exec(cmds[0] ?? '')?.[1];
    expect(name).toBeDefined();
    expect(cmds).toContain(`docker rm -f ${name}`);
  });

  it('forwards an explicit exec timeout and gives the clone a 10-minute ceiling', async () => {
    const ws = await createWorkspace(AUTHED, 'auto/TICKET-1', 'main');
    const cloneCall = vi
      .mocked(execShellAsync)
      .mock.calls.find((call) => (call[0] as string).includes('clone'));
    expect(cloneCall?.[1]).toMatchObject({ timeoutMs: 600_000 });

    await ws.exec('yarn test', { timeoutMs: 600_000 });
    const testCall = vi.mocked(execShellAsync).mock.calls.at(-1);
    expect(testCall?.[0]).toContain('yarn test');
    expect(testCall?.[1]).toMatchObject({ timeoutMs: 600_000 });

    await ws.exec('git status');
    expect(vi.mocked(execShellAsync).mock.calls.at(-1)?.[1]).toMatchObject({
      timeoutMs: undefined,
    });
  });
});

describe('Workspace.execStdin (spawn mocked)', () => {
  beforeEach(() => {
    vi.mocked(execShellAsync).mockReset();
    vi.mocked(execShellAsync).mockImplementation(async () => '');
    vi.mocked(spawnWithStdinAsync).mockReset();
    vi.mocked(spawnWithStdinAsync).mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' });
  });

  it('pipes the content into `docker exec -i` instead of putting it on the command line', async () => {
    const ws = await createWorkspace('https://github.com/acme/repo.git', 'auto/T-1', 'main');
    const content = 'z'.repeat(256 * 1024);
    await ws.execStdin("cat > 'big.json'", content);

    expect(spawnWithStdinAsync).toHaveBeenCalledTimes(1);
    const [file, args, stdin] = vi.mocked(spawnWithStdinAsync).mock.calls[0];
    expect(file).toBe('docker');
    expect(args.slice(0, 4)).toEqual(['exec', '-i', '-w', '/workspace/target-repo']);
    // Tagged so a timed-out command's in-container process tree can be killed.
    expect(args[4]).toBe('-e');
    expect(args[5]).toMatch(/^AUTO_SWE_EXEC_ID=[0-9a-f]{16}$/);
    expect(args[6]).toBe(ws.containerId);
    expect(args.slice(7)).toEqual(['sh', '-c', "cat > 'big.json'"]);
    expect(stdin).toBe(content);
    // Nothing that large ever went through a shell command string.
    for (const call of vi.mocked(execShellAsync).mock.calls) {
      expect((call[0] as string).length).toBeLessThan(4096);
    }
  });

  it('rejects on a non-zero exit like exec does', async () => {
    const ws = await createWorkspace('https://github.com/acme/repo.git', 'auto/T-1', 'main');
    vi.mocked(spawnWithStdinAsync).mockResolvedValueOnce({
      exitCode: 1,
      stderr: 'sh: cannot create',
      stdout: '',
    });
    await expect(ws.execStdin('cat > /nope/x', 'data')).rejects.toMatchObject({
      exitCode: 1,
      stderr: 'sh: cannot create',
    });
  });
});

describe('splitCloneCredential', () => {
  it('strips an embedded token and builds the per-call auth header', () => {
    const { cleanUrl, gitAuthHeader } = splitCloneCredential(
      'https://x-access-token:ghp_secret@github.com/acme/repo.git'
    );
    expect(cleanUrl).toBe('https://github.com/acme/repo.git');
    expect(cleanUrl).not.toContain('ghp_secret');
    expect(gitAuthHeader).toContain('AUTHORIZATION: basic ');
    expect(Buffer.from(gitAuthHeader?.split('basic ')[1] ?? '', 'base64').toString()).toBe(
      'x-access-token:ghp_secret'
    );
  });

  it('passes an unauthenticated URL through with no header', () => {
    expect(splitCloneCredential('https://github.com/acme/repo.git')).toEqual({
      cleanUrl: 'https://github.com/acme/repo.git',
    });
  });

  it('passes a non-URL through untouched', () => {
    expect(splitCloneCredential('git@github.com:acme/repo.git')).toEqual({
      cleanUrl: 'git@github.com:acme/repo.git',
    });
  });
});

describe('safeDepDirName', () => {
  it('keeps a normal name', () => expect(safeDepDirName('acme-api')).toBe('acme-api'));
  it('collapses path separators', () =>
    expect(safeDepDirName('../../etc/passwd')).toBe('etc-passwd'));
  it('strips a leading dash so the name cannot become a flag', () =>
    expect(safeDepDirName('--upload-pack=evil')).toBe('upload-pack-evil'));
  it('neutralizes shell metacharacters', () =>
    expect(safeDepDirName('a;rm -rf /')).toBe('a-rm--rf-'));
  it('bounds the length', () => expect(safeDepDirName('x'.repeat(200))).toHaveLength(64));
  it('falls back when nothing survives', () => expect(safeDepDirName('///')).toBe('dep'));
});

describe('cloneDependencyRepos', () => {
  const exec = vi.fn();
  const ws = { exec };

  beforeEach(() => {
    exec.mockReset();
    exec.mockResolvedValue('');
  });

  it('shallow-clones each dependency into /workspace/deps and scrubs the credential', async () => {
    const cloned = await cloneDependencyRepos(ws, [
      {
        authedCloneUrl: 'https://x-access-token:ghp_secret@github.com/acme/api.git',
        branch: 'main',
        name: 'acme-api',
      },
    ]);

    expect(cloned).toEqual([{ label: 'acme-api', path: '/workspace/deps/acme-api' }]);
    const [cloneCmd, scrubCmd] = exec.mock.calls.map((c) => c[0] as string);
    expect(cloneCmd).toContain('git clone --depth=1');
    expect(cloneCmd).toContain(`-b ${shellQuote('main')}`);
    expect(cloneCmd).toContain(shellQuote('/workspace/deps/acme-api'));
    expect(scrubCmd).toContain('git remote set-url origin');
    expect(scrubCmd).toContain(shellQuote('https://github.com/acme/api.git'));
    expect(scrubCmd).not.toContain('ghp_secret');
  });

  it('omits the branch flag when no branch is given', async () => {
    await cloneDependencyRepos(ws, [{ authedCloneUrl: 'https://h/a.git', name: 'a' }]);
    expect(exec.mock.calls[0][0]).not.toContain('-b ');
  });

  it('shell-quotes every interpolated argument', async () => {
    await cloneDependencyRepos(ws, [
      { authedCloneUrl: 'https://h/a.git;id', branch: 'a;id', name: 'a;id' },
    ]);
    const cloneCmd = exec.mock.calls[0][0] as string;
    expect(cloneCmd).toContain(shellQuote('https://h/a.git;id'));
    expect(cloneCmd).toContain(shellQuote('a;id'));
    // The directory name is sanitized before it is quoted.
    expect(cloneCmd).toContain(shellQuote('/workspace/deps/a-id'));
  });

  it('caps the number of clones', async () => {
    const deps = Array.from({ length: MAX_DEPENDENCY_CHECKOUTS + 3 }, (_, i) => ({
      authedCloneUrl: `https://h/${i}.git`,
      name: `dep-${i}`,
    }));
    const cloned = await cloneDependencyRepos(ws, deps);
    expect(cloned).toHaveLength(MAX_DEPENDENCY_CHECKOUTS);
  });

  it('disambiguates two dependencies that sanitize to the same directory', async () => {
    const cloned = await cloneDependencyRepos(ws, [
      { authedCloneUrl: 'https://h/a.git', name: 'a/b' },
      { authedCloneUrl: 'https://h/b.git', name: 'a;b' },
    ]);
    expect(cloned.map((c) => c.path)).toEqual(['/workspace/deps/a-b', '/workspace/deps/a-b-x']);
  });

  it('is best-effort: one failed clone is cleaned up and the rest still land', async () => {
    exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes('/workspace/deps/bad')) {
        if (cmd.startsWith('git clone')) {
          throw new Error('clone failed');
        }
      }
      return '';
    });

    const cloned = await cloneDependencyRepos(ws, [
      { authedCloneUrl: 'https://h/bad.git', name: 'bad' },
      { authedCloneUrl: 'https://h/good.git', name: 'good' },
    ]);

    expect(cloned).toEqual([{ label: 'good', path: '/workspace/deps/good' }]);
    expect(exec.mock.calls.map((c) => c[0] as string)).toContainEqual(
      `rm -rf ${shellQuote('/workspace/deps/bad')}`
    );
  });

  it('returns an empty list when there are no dependencies', async () => {
    expect(await cloneDependencyRepos(ws, [])).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('authedGitScript against a real git repository', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const HEADER = 'AUTHORIZATION: basic c2VjcmV0';

  // A working clone whose `.git/` an attacker has written to: a pre-push and a
  // reference-transaction hook that dump GIT_CONFIG_PARAMETERS (where
  // `-c http.extraheader` lives), an `insteadOf` and a `pushurl` that redirect
  // origin to an attacker remote, and an fsmonitor command.
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'authed-git-'));
    const good = join(root, 'good.git');
    const evil = join(root, 'evil.git');
    git(root, 'init', '-q', '--bare', good);
    git(root, 'init', '-q', '--bare', evil);
    const seed = join(root, 'seed');
    git(root, 'init', '-q', seed);
    git(
      seed,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init'
    );
    git(seed, 'push', '-q', good, 'HEAD:refs/heads/main');
    const work = join(root, 'work');
    git(root, 'clone', '-q', '-b', 'main', `file://${good}`, work);
    git(work, 'checkout', '-q', '-b', 'auto/T-1');
    git(
      work,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x'
    );
    const loot = join(root, 'loot');
    const hook = `#!/bin/sh\necho "$GIT_CONFIG_PARAMETERS" >> ${loot}\n`;
    mkdirSync(join(work, '.git', 'hooks'), { recursive: true });
    for (const name of ['pre-push', 'reference-transaction']) {
      writeFileSync(join(work, '.git', 'hooks', name), hook);
      chmodSync(join(work, '.git', 'hooks', name), 0o755);
    }
    git(work, 'config', `url.file://${evil}.insteadOf`, `file://${good}`);
    git(work, 'config', '--add', 'remote.origin.pushurl', `file://${evil}`);
    git(work, 'config', 'core.fsmonitor', `echo fsmonitor >> ${loot}; false`);
    return { evil, good, loot, work };
  };

  it('pushes to the real remote without running a planted hook or following a redirect', () => {
    const { evil, good, loot, work } = setup();
    const script = authedGitScript(work, `push origin ${shellQuote('auto/T-1')}`, {
      cleanUrl: `file://${good}`,
      gitAuthHeader: HEADER,
    });
    execFileSync('/bin/sh', ['-c', script], { stdio: 'pipe' });

    expect(existsSync(loot)).toBe(false);
    expect(git(good, 'branch', '--list', 'auto/T-1')).toContain('auto/T-1');
    expect(git(evil, 'branch', '--list')).toBe('');
    const config = readFileSync(join(work, '.git', 'config'), 'utf8');
    expect(config).not.toContain('insteadOf');
    expect(config).not.toContain('pushurl');
    expect(config).not.toContain('fsmonitor');
    // `origin` stays usable: its fetch refspec survives the rewrite.
    expect(config).toContain('fetch = +refs/heads/');
  });

  it('fetches from the real remote and still updates origin/<branch>', () => {
    const { loot, good, work } = setup();
    const script = authedGitScript(work, `fetch origin ${shellQuote('main')}`, {
      cleanUrl: `file://${good}`,
      gitAuthHeader: HEADER,
    });
    execFileSync('/bin/sh', ['-c', script], { stdio: 'pipe' });
    expect(existsSync(loot)).toBe(false);
    expect(git(work, 'rev-parse', 'origin/main').trim()).toBe(
      git(good, 'rev-parse', 'main').trim()
    );
  });

  it('refuses a broken .git instead of falling back to a parent repository', () => {
    const { evil, good, loot, work } = setup();
    // A parent repository the rewrite never touches, whose config sends the
    // push to the attacker and whose history has the branch being pushed.
    const parent = join(work, '..');
    git(parent, 'init', '-q');
    git(parent, 'config', `url.file://${evil}.insteadOf`, `file://${good}`);
    git(
      parent,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'evil'
    );
    git(parent, 'branch', 'auto/T-1');
    git(parent, 'config', 'core.fsmonitor', `echo fsmonitor >> ${loot}; false`);
    // Deleting HEAD is enough to make git stop treating work/.git as a repo.
    rmSync(join(work, '.git', 'HEAD'));

    for (const sub of [
      `push origin ${shellQuote('auto/T-1')}`,
      fetchBranchesSubcommand(['main']),
    ]) {
      const script = authedGitScript(work, sub, {
        cleanUrl: `file://${good}`,
        gitAuthHeader: HEADER,
      });
      expect(() => execFileSync('/bin/sh', ['-c', script], { stdio: 'pipe' })).toThrow(
        /not a valid repository/
      );
    }
    expect(git(evil, 'branch', '--list')).toBe('');
    expect(git(good, 'branch', '--list', 'auto/T-1')).toBe('');
    expect(existsSync(loot)).toBe(false);
  });

  it('fetches a non-default branch into origin/<branch> in a single-branch shallow clone', () => {
    const { good, work } = setup();
    // Publish the work branch, then take the clone every workspace starts from.
    git(good, 'branch', 'auto/T-1', 'main');
    const shallow = join(work, '..', 'shallow');
    git(join(work, '..'), 'clone', '-q', '--depth=50', '-b', 'main', `file://${good}`, shallow);

    // A bare branch name lands only in FETCH_HEAD in such a clone.
    const bare = authedGitScript(shallow, `fetch origin ${shellQuote('auto/T-1')}`, {
      cleanUrl: `file://${good}`,
    });
    execFileSync('/bin/sh', ['-c', bare], { stdio: 'pipe' });
    expect(() => git(shallow, 'rev-parse', '--verify', '-q', 'origin/auto/T-1')).toThrow();

    const script = authedGitScript(shallow, fetchBranchesSubcommand(['auto/T-1']), {
      cleanUrl: `file://${good}`,
      gitAuthHeader: HEADER,
    });
    execFileSync('/bin/sh', ['-c', script], { stdio: 'pipe' });
    expect(git(shallow, 'rev-parse', 'origin/auto/T-1').trim()).toBe(
      git(good, 'rev-parse', 'auto/T-1').trim()
    );
    git(shallow, 'reset', '-q', '--hard', 'origin/auto/T-1');
  });

  it('refuses to run when .git is a gitfile pointing elsewhere', () => {
    const { good, work } = setup();
    const other = mkdtempSync(join(tmpdir(), 'authed-git-gitfile-'));
    writeFileSync(join(other, '.git'), `gitdir: ${join(work, '.git')}\n`);
    const script = authedGitScript(other, `fetch origin ${shellQuote('main')}`, {
      cleanUrl: `file://${good}`,
      gitAuthHeader: HEADER,
    });
    expect(() => execFileSync('/bin/sh', ['-c', script], { stdio: 'pipe' })).toThrow();
  });
});

describe('fetchBranchesSubcommand', () => {
  it('writes a forced refspec per branch into origin/<branch>', () => {
    expect(fetchBranchesSubcommand(['main', "auto/it's"])).toBe(
      `fetch origin '+refs/heads/main:refs/remotes/origin/main' ${shellQuote(
        "+refs/heads/auto/it's:refs/remotes/origin/auto/it's"
      )}`
    );
  });
});

describe('killStrayProcessesScript', () => {
  // Not executed for real: outside a container it would kill every process
  // the test runner's user owns. Its structure is what these assert.
  const script = killStrayProcessesScript();

  it('stops everything before killing anything', () => {
    const stop = script.indexOf('asw_sweep STOP');
    expect(stop).toBeGreaterThan(0);
    expect(script.lastIndexOf('asw_sweep STOP')).toBeGreaterThan(stop);
    expect(script.lastIndexOf('asw_sweep STOP')).toBeLessThan(script.indexOf('asw_sweep KILL'));
  });

  it('spares PID 1, the keeper, and its own process tree', () => {
    expect(script).toContain(
      'if [ "$asw_p" = 1 ] || [ "$asw_p" = "$asw_keeper" ] || asw_mine "$asw_p"; then continue; fi'
    );
    expect(script).toContain('if [ "$asw_a" = "$$" ]; then return 0; fi');
    // The keeper is the lowest-numbered child of PID 1.
    expect(script).toContain('[ "$(asw_ppid "$asw_p")" = 1 ]');
  });

  it('is valid POSIX sh', () => {
    execFileSync('/bin/sh', ['-n', '-c', script]);
  });
});

describe('killTaggedProcessesScript', () => {
  it('rejects anything but a hex tag', () => {
    expect(() => killTaggedProcessesScript("abc'; rm -rf /")).toThrow();
  });

  it('stops every tagged process before killing any', () => {
    const script = killTaggedProcessesScript('00ff');
    expect(script.indexOf('asw_kill STOP')).toBeLessThan(script.indexOf('asw_kill KILL'));
    expect(script).toContain("grep -qs 'AUTO_SWE_EXEC_ID=00ff'");
  });
});
