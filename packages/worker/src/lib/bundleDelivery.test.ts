import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../activities/workspace.js';
import { bundleGit, runBundleDeliveryGit } from './bundleDelivery.js';
import { rebaseOntoMovedBranch } from './pauseRebase.js';

const copyIn = vi.hoisted(() => vi.fn());
vi.mock('./workspaceBackend/index.js', () => ({
  workspaceBackend: () => ({ attach: (id: string) => ({ id }), copyFileIn: copyIn }),
}));

const env = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'delivery@example.invalid',
  GIT_AUTHOR_NAME: 'Delivery test',
  GIT_COMMITTER_EMAIL: 'delivery@example.invalid',
  GIT_COMMITTER_NAME: 'Delivery test',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
let root: string;
let origin: string;
let agent: Workspace;
let base: string;
let trusted: Workspace[];

function localWorkspace(dir: string, authenticated = false): Workspace {
  const capture = (command: string) => {
    const result = spawnSync('sh', ['-c', command.replaceAll('/workspace/', `${dir}/`)], {
      cwd: dir,
      encoding: 'utf8',
      env,
    });
    return { exitCode: result.status ?? -1, stderr: result.stderr, stdout: result.stdout };
  };
  const ws = {
    containerId: dir,
    copyFileOut: vi.fn(async (file: string, maxBytes: number) => {
      const source = join(dir, basename(file));
      const sizeBytes = statSync(source).size;
      if (sizeBytes > maxBytes) {
        throw new RangeError('bundle too large');
      }
      const staging = mkdtempSync(join(root, 'copy-'));
      const path = join(staging, 'bundle');
      copyFileSync(source, path);
      return { cleanup: vi.fn(async () => rmSync(staging, { recursive: true })), path, sizeBytes };
    }),
    destroy: vi.fn(async () => {}),
    exec: vi.fn(async (command: string, _options?: unknown) => {
      const result = capture(command);
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `exit ${result.exitCode}`);
      }
      return result.stdout;
    }),
    execCapture: vi.fn(async (command: string) => capture(command)),
    gitAuthed: vi.fn(async (command: string) => {
      if (!authenticated) {
        throw new Error('Credential reached the agent');
      }
      const result = capture(bundleGit(command));
      if (result.exitCode !== 0) {
        throw new Error(result.stderr);
      }
      return result.stdout;
    }),
  };
  return ws as unknown as Workspace;
}

async function factory(): Promise<Workspace> {
  const dir = join(root, `trusted-${trusted.length}`);
  git(root, 'clone', '--depth=50', '-b', 'main', `file://${origin}`, dir);
  const workspace = localWorkspace(dir, true);
  trusted.push(workspace);
  return workspace;
}

async function deliver(command: string): Promise<string> {
  return runBundleDeliveryGit(agent, factory, base, command);
}

function commit(dir: string, message: string): string {
  git(dir, 'commit', '--allow-empty', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bundle-delivery-'));
  origin = join(root, 'origin.git');
  git(root, 'init', '--bare', '-b', 'main', origin);
  const seed = join(root, 'seed');
  git(root, 'clone', origin, seed);
  base = commit(seed, 'base');
  git(seed, 'push', 'origin', 'HEAD:main');
  const source = join(root, 'agent');
  git(root, 'clone', '--depth=50', '-b', 'main', `file://${origin}`, source);
  git(source, 'checkout', '-b', 'work');
  agent = localWorkspace(source);
  trusted = [];
  copyIn.mockReset().mockImplementation(async (handle, file, path) => {
    copyFileSync(file, join(handle.id, basename(path)));
    return { exitCode: 0, stderr: '', stdout: '' };
  });
});

afterEach(() => {
  for (const ws of trusted) {
    expect(ws.destroy).toHaveBeenCalledOnce();
  }
  for (const [, options] of vi.mocked(agent.exec).mock.calls) {
    expect(options?.secretEnv).toBeUndefined();
  }
  rmSync(root, { force: true, recursive: true });
});

describe('trusted bundle delivery', () => {
  it('preserves multiple commits and pushes the exact SHA without agent credentials', async () => {
    commit(agent.containerId, 'first');
    const tip = commit(agent.containerId, 'second');
    git(agent.containerId, 'config', 'credential.helper', '!exit 98');
    git(agent.containerId, 'config', 'core.hooksPath', '/does-not-exist');
    await deliver("push origin 'work'");
    expect(git(origin, 'rev-parse', 'work')).toBe(tip);
    expect(git(origin, 'log', '--format=%s', 'work')).toBe('second\nfirst\nbase');
    expect(agent.gitAuthed).not.toHaveBeenCalled();
    expect(agent.copyFileOut).toHaveBeenCalledWith(expect.any(String), 512 * 1024 * 1024);
    expect(readFileSync(join(agent.containerId, '.git/config'), 'utf8')).not.toContain(
      'ASW_GIT_AUTH'
    );
  });

  it('creates a new branch with no commits to export', async () => {
    await deliver("push origin 'work'");
    expect(git(origin, 'rev-parse', 'work')).toBe(base);
    expect(agent.copyFileOut).not.toHaveBeenCalled();
  });

  it('resolves an unguarded branch as a branch, even when its name looks like a SHA', async () => {
    const branch = 'a'.repeat(40);
    git(agent.containerId, 'checkout', '-b', branch);
    const tip = commit(agent.containerId, 'hex branch');
    await deliver(`push origin '${branch}'`);
    expect(git(origin, 'rev-parse', `refs/heads/${branch}`)).toBe(tip);
  });

  it('preserves an explicit checked SHA even if the local branch has moved', async () => {
    const tip = commit(agent.containerId, 'checked');
    commit(agent.containerId, 'not checked');
    await deliver(`push origin ${tip}:refs/heads/'work'`);
    expect(git(origin, 'rev-parse', 'work')).toBe(tip);
  });

  it("does not let an untrusted rev-parse substitute the caller's explicit checked SHA", async () => {
    const checked = commit(agent.containerId, 'checked');
    const substitute = commit(agent.containerId, 'substitute');
    const capture = vi.mocked(agent.exec).getMockImplementation();
    if (!capture) {
      throw new Error('Missing exec fixture');
    }
    vi.mocked(agent.exec).mockImplementation(async (command, options) =>
      command.includes('rev-parse --verify') ? substitute : capture(command, options)
    );
    await deliver(`push origin ${checked}:refs/heads/'work'`);
    expect(git(origin, 'rev-parse', 'work')).toBe(checked);
  });

  it('refuses a non-descendant without pushing', async () => {
    git(agent.containerId, 'checkout', '--orphan', 'unrelated');
    const tip = commit(agent.containerId, 'unrelated');
    await expect(deliver(`push origin ${tip}:refs/heads/'work'`)).rejects.toThrow();
    expect(() => git(origin, 'rev-parse', 'work')).toThrow();
  });

  it('checks ancestry against the current trusted remote tip, not just the original base', async () => {
    git(agent.containerId, 'push', 'origin', 'work');
    commit(agent.containerId, 'agent');
    const seed = join(root, 'seed');
    git(seed, 'checkout', '-b', 'work');
    const moved = commit(seed, 'teammate');
    git(seed, 'push', 'origin', 'work');
    await expect(deliver("push origin 'work'")).rejects.toThrow();
    expect(git(origin, 'rev-parse', 'work')).toBe(moved);
    expect(trusted[0]?.gitAuthed).not.toHaveBeenCalledWith(expect.stringContaining('push '));
  });

  it('refuses corrupt bundle bytes before any push', async () => {
    commit(agent.containerId, 'work');
    copyIn.mockImplementation(async (handle, _file, path) => {
      writeFileSync(join(handle.id, basename(path)), 'not a bundle');
      return { exitCode: 0, stderr: '', stdout: '' };
    });
    await expect(deliver("push origin 'work'")).rejects.toThrow();
    expect(trusted[0]?.gitAuthed).not.toHaveBeenCalledWith(expect.stringContaining('push '));
  });

  it('refuses an otherwise valid bundle advertising a different commit', async () => {
    const other = commit(agent.containerId, 'other');
    commit(agent.containerId, 'requested');
    const capture = vi.mocked(agent.exec).getMockImplementation();
    if (!capture) {
      throw new Error('Missing exec fixture');
    }
    vi.mocked(agent.exec).mockImplementation(async (command, options) => {
      if (command.includes('update-ref refs/asw-delivery/export ')) {
        git(agent.containerId, 'update-ref', 'refs/asw-delivery/export', other);
        return '';
      }
      return capture(command, options);
    });
    await expect(deliver("push origin 'work'")).rejects.toThrow('does not match');
    expect(trusted[0]?.gitAuthed).not.toHaveBeenCalledWith(expect.stringContaining('push '));
  });

  it('refuses corrupted pack data even when bundle verification accepts the header', async () => {
    commit(agent.containerId, 'work');
    copyIn.mockImplementation(async (handle, file, path) => {
      const bytes = readFileSync(file);
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
      writeFileSync(join(handle.id, basename(path)), bytes);
      return { exitCode: 0, stderr: '', stdout: '' };
    });
    await expect(deliver("push origin 'work'")).rejects.toThrow();
    expect(trusted[0]?.gitAuthed).not.toHaveBeenCalledWith(expect.stringContaining('push '));
  });

  it('fetches multiple source refs including unrelated history without changing local branches', async () => {
    const seed = join(root, 'seed');
    git(seed, 'checkout', '-b', "source'quoted");
    const source = commit(seed, 'source');
    git(seed, 'push', 'origin', "source'quoted");
    git(seed, 'checkout', '--orphan', 'unrelated');
    const unrelated = commit(seed, 'unrelated');
    git(seed, 'push', 'origin', 'unrelated');
    await deliver(
      "fetch origin '+refs/heads/source'\\''quoted:refs/remotes/origin/source'\\''quoted' '+refs/heads/unrelated:refs/remotes/origin/unrelated'"
    );
    expect(git(agent.containerId, 'rev-parse', "refs/remotes/origin/source'quoted")).toBe(source);
    expect(git(agent.containerId, 'rev-parse', 'refs/remotes/origin/unrelated')).toBe(unrelated);
    expect(git(agent.containerId, 'rev-parse', 'HEAD')).toBe(base);
  });

  it('propagates cap and copy failures and destroys the trusted workspace', async () => {
    commit(agent.containerId, 'work');
    vi.mocked(agent.copyFileOut).mockRejectedValueOnce(new RangeError('bundle too large'));
    await expect(deliver("push origin 'work'")).rejects.toThrow('bundle too large');
    copyIn.mockResolvedValueOnce({ exitCode: 1, stderr: 'copy refused', stdout: '' });
    await expect(deliver("push origin 'work'")).rejects.toThrow('copy refused');
  });

  it('fetches a moved remote through a local bundle and rebases on resume', async () => {
    git(agent.containerId, 'push', 'origin', 'work');
    commit(agent.containerId, 'agent');
    const seed = join(root, 'seed');
    git(seed, 'checkout', '-b', 'work');
    const remoteTip = commit(seed, 'teammate');
    git(seed, 'push', 'origin', 'work');
    const resumed = { ...agent, gitAuthed: deliver };
    const rebased = await rebaseOntoMovedBranch(resumed, 'work', { replayBase: base });
    expect(rebased).toBe(git(agent.containerId, 'rev-parse', 'HEAD'));
    expect(git(agent.containerId, 'rev-parse', 'HEAD^')).toBe(remoteTip);
    await deliver(`push origin ${rebased}:refs/heads/'work'`);
    expect(git(origin, 'log', '--format=%s', 'work')).toBe('agent\nteammate\nbase');
    expect(agent.gitAuthed).not.toHaveBeenCalled();
  });

  it('distinguishes an absent branch from a failed fetch using trusted ls-remote', async () => {
    await expect(
      deliver("fetch origin '+refs/heads/absent:refs/remotes/origin/absent'")
    ).rejects.toThrow();
    expect(await deliver("ls-remote --heads origin 'absent'")).toBe('');
    expect(agent.gitAuthed).not.toHaveBeenCalled();
  });

  it('fetches a branch equal to the original base without an empty bundle', async () => {
    await deliver("fetch origin '+refs/heads/main:refs/remotes/origin/main'");
    expect(git(agent.containerId, 'rev-parse', 'refs/remotes/origin/main')).toBe(base);
    expect(copyIn).not.toHaveBeenCalled();
  });

  it('deepens only when the cheap trusted clone cannot reach the original base', async () => {
    const seed = join(root, 'seed');
    for (let i = 0; i < 55; i++) {
      commit(seed, `remote ${i}`);
    }
    git(seed, 'push', 'origin', 'main');
    await deliver("fetch origin '+refs/heads/main:refs/remotes/origin/main'");
    expect(git(agent.containerId, 'rev-parse', 'origin/main')).toBe(git(seed, 'rev-parse', 'HEAD'));
    expect(trusted[0]?.gitAuthed).toHaveBeenCalledWith('fetch --unshallow origin');
  });

  it('preserves merge commits and both parents', async () => {
    git(agent.containerId, 'checkout', '-b', 'source');
    const source = commit(agent.containerId, 'source');
    git(agent.containerId, 'checkout', 'work');
    const target = commit(agent.containerId, 'target');
    git(agent.containerId, 'merge', '--no-ff', '-m', 'merge', 'source');
    const tip = git(agent.containerId, 'rev-parse', 'HEAD');
    await deliver("push origin 'work'");
    expect(git(origin, 'rev-parse', 'work')).toBe(tip);
    expect(git(origin, 'show', '-s', '--format=%P', 'work')).toBe(`${target} ${source}`);
  });
});
