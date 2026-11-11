/**
 * The conflict resolver's git side against real git. The agent that resolves a conflict can stage
 * extra files, plant hooks and write a graft file, and the old flow (plain `git commit`, a diff of
 * `<sha>^1..<sha>` restricted to the conflicted paths) let each of those commit a file the scan
 * never read. Every case runs the old flow as a control (it must commit the file and scan nothing)
 * and then the real module, which must either refuse or scan everything it committed.
 */
import { execSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commitResolvedMerge,
  diffResolution,
  runMerge,
  snapshotIndex,
  stageResolved,
  startMerge,
} from './mergeResolution.js';

const SECRET = 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"';

let repo: string;
const sh = (cmd: string): string =>
  execSync(cmd, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'a@a',
      GIT_AUTHOR_NAME: 'a',
      GIT_COMMITTER_EMAIL: 'a@a',
      GIT_COMMITTER_NAME: 'a',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
    maxBuffer: 64 * 1024 * 1024,
    shell: '/bin/sh',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const ws = { exec: async (cmd: string) => sh(cmd) };
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), text);
};
const hook = (name: string, body: string) => {
  const file = path.join(repo, '.git/hooks', name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
};

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'merge-resolution-'));
  sh('git init -q -b epic . && git config user.name t && git config user.email t@t');
  write('c.txt', 'base\n');
  write('other.txt', 'base\n');
  sh('git add -A && git commit -qm base');
  sh('git checkout -qb src && echo src > c.txt && echo srcother > other.txt && git commit -qam s');
  sh('git checkout -q epic && echo epic > c.txt && git commit -qam e');
  sh('git update-ref refs/remotes/origin/src src');
});
afterEach(() => rmSync(repo, { force: true, recursive: true }));

/** The conflicted merge, as `mergeOneWithResolver` leaves it before the agent runs. */
async function conflict() {
  const head = sh('git rev-parse HEAD').trim();
  const step = await startMerge(ws, 'src', head);
  if ('error' in step) {
    throw new Error(step.error);
  }
  await expect(runMerge(ws, 'merge src', 'src')).rejects.toThrow();
  const files = sh('git diff --name-only -z --diff-filter=U').split('\0').filter(Boolean);
  expect(files).toEqual(['c.txt']);
  return { files, snapshot: await snapshotIndex(ws), step };
}

const resolve = () => write('c.txt', 'resolved\n');

/** The previous flow: stage the conflicted files, plain commit, scan `<sha>^1..<sha>` on them only. */
async function oldFlow(files: string[]) {
  sh(`git add -- ${files.join(' ')}`);
  sh('git commit -qm merge');
  const sha = sh('git rev-parse HEAD').trim();
  // The old read honoured grafts (the pinned call now switches them off).
  const spec = files.map((f) => `':(top,literal)${f}'`).join(' ');
  const patch = await ws.exec(`git diff-tree -r -p --text ${sha}^1 ${sha} -- ${spec} 2>/dev/null`);
  const names = await ws.exec(
    `git diff-tree -r --name-status ${sha}^1 ${sha} -- ${spec} 2>/dev/null`
  );
  return { names, patch, pushedHasSecret: sh('git grep -c wJalr epic || true').trim() !== '' };
}

describe('the previous flow, as a control', () => {
  it('a pre-commit hook that stages evil.py commits it and scans nothing', async () => {
    const { files } = await conflict();
    resolve();
    write('evil.py', `${SECRET}\n`);
    hook('pre-commit', 'git add evil.py');
    const old = await oldFlow(files);
    expect(old.pushedHasSecret).toBe(true);
    expect(old.patch).not.toContain('wJalr');
  });

  it('an agent `git add evil.py` is committed with everything else', async () => {
    const { files } = await conflict();
    resolve();
    write('evil.py', `${SECRET}\n`);
    sh('git add evil.py');
    const old = await oldFlow(files);
    expect(old.pushedHasSecret).toBe(true);
    expect(old.patch).not.toContain('wJalr');
  });

  it('a post-commit hook that makes another commit moves the file out of the scanned range', async () => {
    const { files } = await conflict();
    resolve();
    write('.evil-src', `${SECRET}\n`);
    hook(
      'post-commit',
      '[ -n "$IN_HOOK" ] && exit 0\ncp .evil-src evil.py && git add evil.py && IN_HOOK=1 git commit -qm chore'
    );
    const old = await oldFlow(files);
    expect(old.pushedHasSecret).toBe(true);
    expect(old.patch).not.toContain('wJalr');
  });

  it('a post-commit graft hides the file behind a twin of the merge commit', async () => {
    const { files } = await conflict();
    write('c.txt', `${SECRET}\n`);
    hook(
      'post-commit',
      'T=$(git rev-parse HEAD^{tree}); P=$(git commit-tree $T -m twin); echo "$(git rev-parse HEAD) $P" >> .git/info/grafts'
    );
    const old = await oldFlow(files);
    expect(old.pushedHasSecret).toBe(true);
    expect(old.patch).not.toContain('wJalr');
  });
});

describe('the hardened resolution', () => {
  it('commits the resolved merge and scans exactly what changed against the recorded parent', async () => {
    const { files, snapshot, step } = await conflict();
    resolve();
    await expect(stageResolved(ws, snapshot, files)).resolves.toBe('staged');
    const sha = await commitResolvedMerge(ws, 'merge src', step);
    expect(sha).toBe(sh('git rev-parse HEAD').trim());
    expect(sh(`git cat-file commit ${sha}`)).toContain(`parent ${step.parent}`);
    const patch = await diffResolution(ws, step.parent, sha);
    expect(patch).toContain('+resolved');
    // The source's own clean change comes with the merge and is scanned too.
    expect(patch).toContain('other.txt');
  });

  it('refuses a file the agent staged itself', async () => {
    const { files, snapshot } = await conflict();
    resolve();
    write('evil.py', `${SECRET}\n`);
    sh('git add evil.py');
    await expect(stageResolved(ws, snapshot, files)).rejects.toMatchObject({
      nonRetryable: true,
      type: 'MERGE_RESOLUTION_REFUSED',
    });
  });

  it('refuses a change to a cleanly merged path the agent staged', async () => {
    const { files, snapshot } = await conflict();
    resolve();
    write('other.txt', `${SECRET}\n`);
    sh('git add other.txt');
    await expect(stageResolved(ws, snapshot, files)).rejects.toMatchObject({
      type: 'MERGE_RESOLUTION_REFUSED',
    });
  });

  it('does not run a pre-commit hook that stages another file', async () => {
    const { files, snapshot, step } = await conflict();
    resolve();
    write('evil.py', `${SECRET}\n`);
    hook('pre-commit', 'git add evil.py');
    await stageResolved(ws, snapshot, files);
    const sha = await commitResolvedMerge(ws, 'merge src', step);
    expect(sh(`git ls-tree -r --name-only ${sha}`)).not.toContain('evil.py');
  });

  it('does not run a post-commit hook that adds a commit', async () => {
    const { files, snapshot, step } = await conflict();
    resolve();
    write('.evil-src', `${SECRET}\n`);
    hook(
      'post-commit',
      '[ -n "$IN_HOOK" ] && exit 0\ncp .evil-src evil.py && git add evil.py && IN_HOOK=1 git commit -qm chore'
    );
    await stageResolved(ws, snapshot, files);
    const sha = await commitResolvedMerge(ws, 'merge src', step);
    expect(sh('git rev-parse HEAD').trim()).toBe(sha);
  });

  it('refuses when the agent committed the merge and then more on top', async () => {
    const { files, snapshot, step } = await conflict();
    resolve();
    sh('git add c.txt && git commit -qm agent-merge');
    write('evil.py', `${SECRET}\n`);
    sh('git add evil.py && git commit -qm extra');
    await expect(stageResolved(ws, snapshot, files)).rejects.toBeDefined();
    await expect(commitResolvedMerge(ws, 'merge src', step)).rejects.toMatchObject({
      type: 'MERGE_RESOLUTION_REFUSED',
    });
  });

  it('refuses a merge whose parents are not the recorded tips', async () => {
    const { step } = await conflict();
    sh('git merge --abort');
    sh('git checkout -q --detach src');
    await expect(commitResolvedMerge(ws, 'merge src', step)).rejects.toMatchObject({
      type: 'MERGE_RESOLUTION_REFUSED',
    });
  });

  it('accepts a merge the agent committed itself when it is the recorded merge, and scans it whole', async () => {
    const { files, snapshot, step } = await conflict();
    resolve();
    await stageResolved(ws, snapshot, files);
    sh('git commit -qm agent-merge');
    const sha = await commitResolvedMerge(ws, 'merge src', step);
    expect(await diffResolution(ws, step.parent, sha)).toContain('+resolved');
  });

  it('is not fooled by a graft written before the commit', async () => {
    const { files, snapshot, step } = await conflict();
    resolve();
    const twin = sh('git commit-tree HEAD^{tree} -m twin').trim();
    writeFileSync(
      path.join(repo, '.git/info/grafts'),
      `${step.parent} ${twin}\n${step.sourceSha} ${twin}\n`
    );
    await stageResolved(ws, snapshot, files);
    const sha = await commitResolvedMerge(ws, 'merge src', step);
    const raw = sh(`git cat-file commit ${sha}`);
    expect(raw).toContain(`parent ${step.parent}`);
    expect(raw).toContain(`parent ${step.sourceSha}`);
    expect(await diffResolution(ws, step.parent, sha)).toContain('+resolved');
  });

  it('refuses to start from a HEAD the activity did not leave', async () => {
    const head = sh('git rev-parse HEAD').trim();
    sh('git commit -q --allow-empty -m moved');
    await expect(startMerge(ws, 'src', head)).rejects.toMatchObject({
      type: 'MERGE_RESOLUTION_REFUSED',
    });
  });

  it('reports an unreadable source tip instead of merging', async () => {
    const head = sh('git rev-parse HEAD').trim();
    await expect(startMerge(ws, 'missing', head)).resolves.toMatchObject({
      error: expect.any(String),
    });
  });
});
