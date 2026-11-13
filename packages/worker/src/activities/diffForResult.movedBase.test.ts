/**
 * An agent that moves the base or the head the scan reads, against real git and a real bare remote.
 *
 * With no path guard a step used to resolve `HEAD` and `origin/<default>` AFTER the agent ran,
 * commit with the hook-enabled `git commit`, and push the branch by NAME. Each attack below leaves
 * the diff the security gate reads EMPTY while the secret reaches the remote. The control in each
 * case is that previous logic (a copy, `oldFinish`), which must show the secret on the remote and
 * not in the diff; the real logic (`finish`: record the base first, hardened commit, push the sha,
 * diff base..sha) must never push something its diff does not show.
 */
import { execSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commitStaged,
  diffForResult,
  guardedGit,
  type PathGuard,
  pinnedDiffTreeCommand,
  pushRefspec,
  startPathGuard,
} from './allowedPaths.js';

const SECRET = 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"';

let root: string;
let repo: string;
let remote: string;
const run = (cwd: string, cmd: string): string =>
  execSync(cmd, {
    cwd,
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
const sh = (cmd: string) => run(repo, cmd);
const workspace = { exec: async (cmd: string) => sh(cmd) };
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), text);
};
const remoteHasSecret = () => run(remote, 'git grep -c wJalr auto/T || true').trim() !== '';

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'moved-base-'));
  remote = path.join(root, 'remote.git');
  run(
    root,
    `git init -q --bare -b main remote.git && git init -q -b main seed && cd seed && echo hello > a.txt && git add . && git commit -qm init && git push -q ../remote.git main`
  );
  run(root, 'git clone -q remote.git repo');
  repo = path.join(root, 'repo');
  sh('git checkout -qb auto/T && git config user.name t && git config user.email t@t');
});
afterEach(() => rmSync(root, { force: true, recursive: true }));

/** What the unguarded step did before: re-resolve both ends after the agent, plain commit, push by name. */
async function oldFinish(): Promise<{ diff: string; secretPushed: boolean }> {
  sh('git add -A');
  sh('git diff --cached --quiet || git commit -qm "auto: implement T"');
  sh("git push -q origin 'auto/T'");
  const head = sh("git rev-parse --verify 'HEAD^{commit}'").trim();
  const base = sh("git rev-parse --verify 'origin/main^{commit}'").trim();
  const diff = await workspace.exec(
    pinnedDiffTreeCommand(base, head, { context: 3, kind: 'patch' })
  );
  return { diff, secretPushed: remoteHasSecret() };
}

/** What every step does now (the order of `executeImplementation`). */
async function finish(agent: () => void) {
  const baseSha = sh('git rev-parse HEAD').trim();
  const guard: PathGuard = await startPathGuard(workspace, 'main', undefined, baseSha);
  agent();
  sh('git add -A');
  const pushSha = await commitStaged(workspace, 'auto: implement T', guard);
  sh(`git push -q origin ${pushRefspec('auto/T', pushSha)}`);
  const diff = await diffForResult(workspace, guard, pushSha);
  return { diff, pushSha, secretPushed: remoteHasSecret() };
}

const evil = () => write('evil.py', `${SECRET}\n`);
const commitEvil = () => {
  evil();
  sh('git add -A && git commit -qm x');
};

const attacks: Array<{
  name: string;
  /** What the agent does; the activity then runs its own commit, push and diff. */
  agent: () => void;
  /** Whether the secret still reaches the remote once the activity pushes the sha it pinned. */
  reaches: boolean;
}> = [
  {
    agent: () => {
      commitEvil();
      sh('git update-ref refs/remotes/origin/main HEAD');
    },
    name: 'A1 update-ref moves origin/main onto the commit',
    reaches: true,
  },
  {
    agent: () => {
      commitEvil();
      sh('git checkout -q --detach origin/main');
    },
    name: 'A2 detaches HEAD at origin/main after committing',
    reaches: false,
  },
  {
    agent: () => {
      evil();
      const hook = path.join(repo, '.git/hooks/post-commit');
      writeFileSync(hook, '#!/bin/sh\ngit update-ref refs/remotes/origin/main HEAD\n');
      chmodSync(hook, 0o755);
    },
    name: 'A3 a post-commit hook repoints origin/main on the activity commit',
    reaches: true,
  },
  {
    agent: () => {
      commitEvil();
      sh('git update-ref refs/heads/origin/main HEAD');
    },
    name: 'A4 a branch named origin/main shadows the remote-tracking ref',
    reaches: true,
  },
  {
    agent: () => {
      commitEvil();
      sh('git tag origin/main HEAD');
    },
    name: 'A4b a tag named origin/main shadows the remote-tracking ref',
    reaches: true,
  },
  {
    agent: () => {
      commitEvil();
      sh(
        'git pack-refs --all && sed -i "s#^[0-9a-f]* refs/remotes/origin/main#$(git rev-parse HEAD) refs/remotes/origin/main#" .git/packed-refs && rm -f .git/refs/remotes/origin/main'
      );
    },
    name: 'A5 packed-refs edited so origin/main names the commit',
    reaches: true,
  },
  {
    agent: () => {
      commitEvil();
      sh('git checkout -qb scratch origin/main');
    },
    name: 'A6 switches to a scratch branch cut from origin/main',
    reaches: false,
  },
  {
    agent: () => {
      commitEvil();
      sh('git update-ref refs/remotes/origin/main HEAD');
      write('b.txt', 'benign\n');
      sh('git add -A && git commit -qm benign');
    },
    name: 'A7 base repointed to an ancestor that holds the file, plus a harmless follow-up commit',
    reaches: true,
  },
];

describe('the unguarded step: a base or head the agent moved', () => {
  it('control: an untouched change is in the diff on both logics', async () => {
    const before = sh('git rev-parse HEAD').trim();
    evil();
    const after = await finish(() => {});
    expect(after.diff).toContain('wJalrXUtnFEMI');
    expect(after.secretPushed).toBe(true);
    expect(sh('git rev-parse HEAD^').trim()).toBe(before);
  });

  describe.each(attacks)('$name', ({ agent, reaches }) => {
    it('control: the previous logic pushes the secret and its diff does not show it', async () => {
      agent();
      const old = await oldFinish();
      expect(old.secretPushed).toBe(true);
      expect(old.diff).not.toContain('wJalrXUtnFEMI');
    });

    it('never pushes what the scanned diff does not show', async () => {
      const result = await finish(agent);
      // The commit the agent left HEAD on is what is pushed, and what is pushed is what is read:
      // a HEAD parked back on the base pushes the base, with nothing to hide.
      expect(result.secretPushed).toBe(reaches);
      expect(result.diff.includes('wJalrXUtnFEMI')).toBe(reaches);
      // What is reported is what was pushed.
      expect(run(remote, 'git rev-parse auto/T').trim()).toBe(result.pushSha);
    });
  });

  it('a hook cannot run: the activity commit is made with hooks off', async () => {
    const result = await finish(() => {
      evil();
      const hook = path.join(repo, '.git/hooks/pre-commit');
      writeFileSync(hook, '#!/bin/sh\ntouch hook-ran\ngit add hook-ran\n');
      chmodSync(hook, 0o755);
    });
    expect(run(remote, 'git ls-tree -r --name-only auto/T')).not.toContain('hook-ran');
    expect(result.diff).toContain('wJalrXUtnFEMI');
  });
});

describe('grafts and the commit-graph', () => {
  it('a graft cannot rewrite a parent the activity reads', async () => {
    write('one.txt', '1\n');
    sh('git add -A && git commit -qm one');
    const tip = sh('git rev-parse HEAD').trim();
    const real = sh('git rev-parse HEAD^').trim();
    const twin = sh(`git commit-tree HEAD^{tree} -m twin`).trim();
    writeFileSync(path.join(repo, '.git/info/grafts'), `${tip} ${twin}\n`);
    // Plain git believes the graft.
    expect(sh('git rev-parse HEAD^').trim()).toBe(twin);
    // The pinned call does not.
    expect(sh(guardedGit('rev-parse HEAD^')).trim()).toBe(real);
  });

  it('a fix session on an existing branch measures from the fork point read at start, graft or not', async () => {
    const fork = sh('git rev-parse HEAD').trim();
    write('prior.txt', 'prior\n');
    sh('git add -A && git commit -qm prior');
    const sessionBase = sh('git rev-parse HEAD').trim();
    const guard = await startPathGuard(workspace, 'main', undefined);
    expect(guard.sessionBase).toBe(sessionBase);
    expect(guard.report.sha).toBe(fork);
    // The agent commits the secret, then grafts the fork point's parent onto its own commit.
    commitEvil();
    const evilSha = sh('git rev-parse HEAD').trim();
    writeFileSync(path.join(repo, '.git/info/grafts'), `${fork} ${evilSha}\n`);
    write('ok.txt', 'ok\n');
    sh('git add -A');
    const pushSha = await commitStaged(workspace, 'fix', guard);
    const diff = await diffForResult(workspace, guard, pushSha);
    expect(diff).toContain('wJalrXUtnFEMI');
    expect(diff).toContain('prior.txt');
  });
});
