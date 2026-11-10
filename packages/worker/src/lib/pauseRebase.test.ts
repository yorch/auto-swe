import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PathGuard } from '../activities/allowedPaths.js';
import type { Workspace } from '../activities/workspace.js';
import { rebaseOntoMovedBranch } from './pauseRebase.js';

const ENV = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_AUTHOR_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV }).trim();

let root: string;
let origin: string;
let work: string;
let other: string;

/** A workspace over the real clone `work`: `gitAuthed` is plain git, as origin needs no credential here. */
function workspace(): Pick<Workspace, 'exec' | 'gitAuthed'> {
  const sh = (command: string) =>
    execFileSync('sh', ['-c', command], { cwd: work, encoding: 'utf8', env: ENV });
  return {
    exec: async (command: string) => sh(command),
    gitAuthed: async (sub) => sh(`git ${sub}`),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rebase-'));
  origin = join(root, 'origin.git');
  work = join(root, 'work');
  other = join(root, 'other');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { env: ENV });
  execFileSync('git', ['clone', origin, work], { env: ENV, stdio: 'ignore' });
  writeFileSync(join(work, 'a.txt'), 'one\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'base');
  git(work, 'push', 'origin', 'HEAD:main');
  git(work, 'checkout', '-b', 'feature');
  git(work, 'push', 'origin', 'feature');
  // The resumed run's checkout is cut at this commit, then the agent commits.
  writeFileSync(join(work, 'agent.txt'), 'agent\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'agent work');
  execFileSync('git', ['clone', '-b', 'feature', origin, other], { env: ENV, stdio: 'ignore' });
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

/** Someone else pushes to the branch while the run waits. */
function pushMeanwhile(file: string, body: string) {
  writeFileSync(join(other, file), body);
  git(other, 'add', '-A');
  git(other, 'commit', '-m', 'teammate');
  git(other, 'push', 'origin', 'feature');
}

describe('rebaseOntoMovedBranch', () => {
  it('does nothing when the branch has not moved', async () => {
    const before = git(work, 'rev-parse', 'HEAD');
    await expect(rebaseOntoMovedBranch(workspace(), 'feature')).resolves.toBeUndefined();
    expect(git(work, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('does nothing when the branch is not on the remote', async () => {
    await expect(rebaseOntoMovedBranch(workspace(), 'never-pushed')).resolves.toBeUndefined();
  });

  it('replays the run on top of a moved branch, so the push fast-forwards without force', async () => {
    pushMeanwhile('theirs.txt', 'theirs\n');
    // Without the rebase the push is the late, opaque failure.
    expect(() => git(work, 'push', 'origin', 'HEAD:refs/heads/feature')).toThrow();

    const head = await rebaseOntoMovedBranch(workspace(), 'feature');

    expect(head).toBe(git(work, 'rev-parse', 'HEAD'));
    git(work, 'push', 'origin', `${head}:refs/heads/feature`);
    expect(git(origin, 'rev-parse', 'feature')).toBe(head);
    expect(git(origin, 'log', '--format=%s', 'feature')).toBe('agent work\nteammate\nbase');
  });

  it('fails non-retryably on a conflict, leaves no rebase half done and pushes nothing', async () => {
    writeFileSync(join(work, 'a.txt'), 'agent edit\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'agent edits a');
    pushMeanwhile('a.txt', 'teammate edit\n');
    const remoteBefore = git(origin, 'rev-parse', 'feature');

    await expect(rebaseOntoMovedBranch(workspace(), 'feature')).rejects.toMatchObject({
      nonRetryable: true,
      type: 'NEEDS_INPUT_PUSH_CONFLICT',
    });

    expect(git(work, 'status', '--porcelain')).toBe('');
    expect(() => git(work, 'rev-parse', '--verify', 'REBASE_HEAD')).toThrow();
    expect(git(origin, 'rev-parse', 'feature')).toBe(remoteBefore);
  });

  const guardFor = (allowedPaths: string[]): PathGuard => ({
    allowedPaths,
    refuseWorkflowChanges: false,
    report: { sha: git(work, 'rev-parse', 'HEAD'), twoTree: true },
    sessionBase: git(work, 'rev-parse', 'HEAD~1'),
  });

  it('replays only the commits after the resume checkout when the branch was force-moved', async () => {
    // An earlier round pushed "agent work"; the run resumes from there and commits more.
    git(work, 'push', 'origin', 'feature');
    const replayBase = git(work, 'rev-parse', 'HEAD');
    writeFileSync(join(work, 'resumed.txt'), 'resumed\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'resumed work');
    // Meanwhile the branch is force-moved: the earlier push is gone from it.
    git(other, 'fetch', 'origin');
    git(other, 'reset', '--hard', 'origin/main');
    writeFileSync(join(other, 'theirs.txt'), 'theirs\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-m', 'teammate');
    git(other, 'push', '--force', 'origin', 'HEAD:feature');

    await rebaseOntoMovedBranch(workspace(), 'feature', { replayBase });

    expect(git(work, 'log', '--format=%s', 'HEAD')).toBe('resumed work\nteammate\nbase');
  });

  it('re-checks the replayed result against the path guard, measured from the remote branch', async () => {
    pushMeanwhile('theirs.txt', 'theirs\n');
    // The teammate's file is outside the allowed paths and does not count; the agent's does.
    const head = await rebaseOntoMovedBranch(workspace(), 'feature', {
      guard: guardFor(['agent.txt']),
    });
    expect(head).toBe(git(work, 'rev-parse', 'HEAD'));
  });

  it('refuses a replayed change outside the allowed paths', async () => {
    pushMeanwhile('theirs.txt', 'theirs\n');
    await expect(
      rebaseOntoMovedBranch(workspace(), 'feature', { guard: guardFor(['docs/']) })
    ).rejects.toMatchObject({ nonRetryable: true, type: 'DIFF_OUTSIDE_ALLOWED_PATHS' });
  });

  it('ignores a replace ref the agent planted, so it cannot swap in a different commit', async () => {
    const agentCommit = git(work, 'rev-parse', 'HEAD');
    // An evil twin of the agent commit that also writes a file outside the allowed paths.
    git(work, 'checkout', '-q', '--detach', 'HEAD~1');
    writeFileSync(join(work, 'agent.txt'), 'agent\n');
    writeFileSync(join(work, 'secret.txt'), 'pwn\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'agent work');
    const evil = git(work, 'rev-parse', 'HEAD');
    git(work, 'checkout', '-q', 'feature');
    git(work, 'replace', agentCommit, evil);
    pushMeanwhile('theirs.txt', 'theirs\n');

    const head = await rebaseOntoMovedBranch(workspace(), 'feature', {
      guard: guardFor(['agent.txt']),
    });

    expect(head).toBeDefined();
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', head as string], {
      cwd: work,
      encoding: 'utf8',
      env: { ...ENV, GIT_NO_REPLACE_OBJECTS: '1' },
    });
    expect(files).not.toContain('secret.txt');
  });

  it.each([
    ['a tag', (sha: string) => git(work, 'tag', 'origin/feature', sha)],
    ['a local branch', (sha: string) => git(work, 'branch', 'origin/feature', sha)],
  ])('ignores %s named origin/<branch> that the agent planted, so the base cannot be moved', async (_label, plant) => {
    // An evil commit on top of the remote tip that writes a file outside the allowed paths.
    git(work, 'checkout', '-q', '--detach', 'HEAD~1');
    writeFileSync(join(work, 'evil.txt'), 'pwn\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'evil');
    const evil = git(work, 'rev-parse', 'HEAD');
    git(work, 'checkout', '-q', 'feature');
    plant(evil);
    pushMeanwhile('theirs.txt', 'theirs\n');

    const head = await rebaseOntoMovedBranch(workspace(), 'feature', {
      guard: guardFor(['agent.txt']),
    });

    expect(head).toBeDefined();
    const files = git(work, 'ls-tree', '-r', '--name-only', head as string);
    expect(files).not.toContain('evil.txt');
    expect(git(work, 'log', '--format=%s', head as string)).toBe('agent work\nteammate\nbase');
  });

  it('reports a fetch failure as retryable, not as an absent branch', async () => {
    const ws = workspace();
    await expect(
      rebaseOntoMovedBranch(
        {
          exec: ws.exec,
          gitAuthed: async () => {
            throw new Error('network down');
          },
        },
        'feature'
      )
    ).rejects.toMatchObject({ nonRetryable: false, type: 'NEEDS_INPUT_REBASE_FAILED' });
  });

  it('reports a failure that is not a conflict as such, not as a push conflict', async () => {
    pushMeanwhile('theirs.txt', 'theirs\n');
    // A dirty tree refuses the rebase before any commit is replayed.
    writeFileSync(join(work, 'a.txt'), 'dirty\n');
    await expect(rebaseOntoMovedBranch(workspace(), 'feature')).rejects.toMatchObject({
      nonRetryable: true,
      type: 'NEEDS_INPUT_REBASE_FAILED',
    });
  });
});
