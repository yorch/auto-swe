import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
