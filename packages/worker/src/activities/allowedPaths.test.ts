/**
 * The guard against real git, no mocks: a throwaway repository plays the workspace,
 * and each bypass the review found is carried out for real. Each of the first three
 * tests passes a change the earlier guard (`git diff --cached … origin/<default>`
 * before the commit) let through.
 */
import { execSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertCommittedTreeWithinAllowedPaths,
  commitStaged,
  diffForResult,
  pushRefspec,
  startPathGuard,
} from './allowedPaths.js';

let dir: string;
const sh = (cmd: string, env: Record<string, string> = {}): string =>
  execSync(cmd, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', ...env },
    shell: '/bin/sh',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const workspace = { exec: async (cmd: string) => sh(cmd) };
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};
const ALLOWED = ['catalog.ts'];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'allowed-paths-'));
  sh('git init -q -b main && git config user.name t && git config user.email t@t');
  write('catalog.ts', 'export const BUILTIN_MODELS = [];\n');
  write('ci.yml', 'name: ci\n');
  sh('git add -A && git commit -q -m base');
  // The clone's remote-tracking ref, as `git clone` leaves it.
  sh('git update-ref refs/remotes/origin/main HEAD && git checkout -q -b auto/x');
});
afterEach(() => rmSync(dir, { force: true, recursive: true }));

async function runGuarded(agent: () => void): Promise<string | undefined> {
  const guard = await startPathGuard(workspace, 'main', ALLOWED);
  expect(guard).toBeDefined();
  agent();
  sh('git add -A');
  return commitStaged(workspace, 'auto: implement', guard);
}
const pushedFiles = () => sh('git diff --name-only origin/main HEAD').trim();

describe('the committed-range guard', () => {
  it('lets a change inside the allowed paths through, and commits it', async () => {
    await runGuarded(() => write('catalog.ts', 'export const BUILTIN_MODELS = [1];\n'));
    expect(pushedFiles()).toBe('catalog.ts');
  });

  it('bypass A: a pre-commit hook that creates and stages a file at commit time commits nothing extra', async () => {
    // The hook runs after the guard's staged view was taken, which is what let it through.
    await runGuarded(() => {
      write('catalog.ts', 'export const BUILTIN_MODELS = [1];\n');
      write(
        '.git/hooks/pre-commit',
        '#!/bin/sh\nmkdir -p .github/workflows && echo "on: push" > .github/workflows/x.yml && git add .github/workflows/x.yml\n'
      );
      chmodSync(path.join(dir, '.git/hooks/pre-commit'), 0o755);
    });
    expect(pushedFiles()).toBe('catalog.ts');
  });

  it('bypass A: a core.hooksPath set in the repository config is ignored too', async () => {
    await runGuarded(() => {
      write('catalog.ts', 'export const BUILTIN_MODELS = [2];\n');
      write(
        '.git/evil-hooks/pre-commit',
        '#!/bin/sh\necho x > smuggled.txt && git add smuggled.txt\n'
      );
      chmodSync(path.join(dir, '.git/evil-hooks/pre-commit'), 0o755);
      sh('git config core.hooksPath .git/evil-hooks');
    });
    expect(pushedFiles()).toBe('catalog.ts');
  });

  it('bypass B: moving refs/remotes/origin/<default> cannot hide a file', async () => {
    await expect(
      runGuarded(() => {
        write('catalog.ts', 'export const BUILTIN_MODELS = [3];\n');
        write('ci.yml', 'name: pwned\n');
        // The agent commits the out-of-scope change, then makes it the "base".
        sh('git add -A && git commit -q -m sneaky');
        sh('git update-ref refs/remotes/origin/main HEAD');
      })
    ).rejects.toMatchObject({ nonRetryable: true, type: 'DIFF_OUTSIDE_ALLOWED_PATHS' });
  });

  it('bypass B: git replace on the base commit cannot hide a file', async () => {
    const base = sh('git rev-parse HEAD').trim();
    await expect(
      runGuarded(() => {
        write('ci.yml', 'name: pwned\n');
        sh('git add -A && git commit -q -m sneaky');
        const sneaky = sh('git rev-parse HEAD').trim();
        // Make the base look like the commit that already contains the change.
        sh(`git replace ${base} ${sneaky}`);
        write('catalog.ts', 'export const BUILTIN_MODELS = [4];\n');
      })
    ).rejects.toMatchObject({ type: 'DIFF_OUTSIDE_ALLOWED_PATHS' });
  });

  it('fails a branch rewritten to share no history, by what its tree changes', async () => {
    await expect(
      runGuarded(() => {
        sh('git checkout -q --orphan fresh && git rm -rfq ci.yml');
        write('catalog.ts', 'export const BUILTIN_MODELS = [5];\n');
      })
    ).rejects.toMatchObject({ nonRetryable: true, type: 'DIFF_OUTSIDE_ALLOWED_PATHS' });
  });

  it('bypass C: rebuilding HEAD on an OLDER ancestor cannot hide a path restored to its older content', async () => {
    // history: older (ci.yml = v1) <- base (ci.yml = v2), and the workspace starts at base.
    const older = sh('git rev-parse HEAD').trim();
    write('ci.yml', 'name: v2\n');
    sh('git commit -qam v2 && git update-ref refs/remotes/origin/main HEAD');
    await expect(
      runGuarded(() => {
        // The agent re-roots its branch on `older` and changes only the catalog. Measured as a
        // range from the merge base (`older`) that is catalog-only, and ci.yml (v1 again) is
        // missed; against the starting TREE, ci.yml differs from v2 and is caught.
        sh(`git checkout -q -B auto/x ${older}`);
        write('catalog.ts', 'export const BUILTIN_MODELS = [9];\n');
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining('ci.yml'),
      type: 'DIFF_OUTSIDE_ALLOWED_PATHS',
    });
  });

  it('a fix session answers only for its own changes, whatever its branch was cut from', async () => {
    // An earlier session already pushed a catalog change on top of an older base.
    write('catalog.ts', 'export const BUILTIN_MODELS = [1];\n');
    sh('git commit -qam earlier');
    // The default branch has since moved on, so the branch base is older than origin/main.
    sh('git checkout -q main 2>/dev/null || git checkout -q -b main');
    write('ci.yml', 'name: newer default\n');
    sh(
      'git commit -qam newer && git update-ref refs/remotes/origin/main HEAD && git checkout -q auto/x'
    );
    const guard = await startPathGuard(workspace, 'main', ALLOWED);
    write('catalog.ts', 'export const BUILTIN_MODELS = [2];\n');
    sh('git add -A');
    await expect(commitStaged(workspace, 'auto: fix', guard)).resolves.toMatch(/^[0-9a-f]{40}$/);
  });

  it('catches an out-of-scope file the agent committed itself, from any commit in the range', async () => {
    await expect(
      runGuarded(() => {
        write('package.json', '{}\n');
        sh('git add -A && git commit -q -m one');
        sh('git rm -q package.json && git commit -q -m two');
        write('catalog.ts', 'export const BUILTIN_MODELS = [6];\n');
      })
    ).resolves.toMatch(/^[0-9a-f]{40}$/);
    // Added then removed: the range's net change is the catalog alone.
    expect(pushedFiles()).toBe('catalog.ts');
  });

  it('counts both ends of a rename', async () => {
    await expect(runGuarded(() => sh('git mv catalog.ts moved.ts'))).rejects.toMatchObject({
      message: expect.stringContaining('moved.ts'),
    });
  });

  it('measures from the starting commit, so a default branch that moved on does not matter', async () => {
    const guard = await startPathGuard(workspace, 'main', ALLOWED);
    sh(
      'git checkout -q main && echo y >> ci.yml && git commit -qam later && git checkout -q auto/x'
    );
    write('catalog.ts', 'export const BUILTIN_MODELS = [7];\n');
    sh('git add -A');
    const sha = await commitStaged(workspace, 'auto: implement', guard);
    await expect(
      assertCommittedTreeWithinAllowedPaths(
        workspace,
        guard as NonNullable<typeof guard>,
        sha as string
      )
    ).resolves.toBeUndefined();
  });
});

describe('the pushed commit is the checked commit', () => {
  it('bypass D: leaving HEAD on a scratch branch cannot get the work branch pushed unchecked', async () => {
    const base = sh('git rev-parse HEAD').trim();
    const sha = await runGuarded(() => {
      // The agent commits an out-of-scope file on the work branch, then moves HEAD elsewhere.
      write('ci.yml', 'name: pwned\n');
      sh('git add -A && git commit -q -m sneaky');
      sh(`git checkout -q -b scratch ${base}`);
      write('catalog.ts', 'export const BUILTIN_MODELS = [1];\n');
    });
    // The platform's commit landed on `scratch`, and only the catalog differs from the base.
    expect(sha).toBe(sh('git rev-parse scratch').trim());
    // Pushing the branch by name (what the step used to do) sends the unchecked commit.
    // Hand the bare remote the base first so the diff below is against the same history.
    const remote = mkdtempSync(path.join(tmpdir(), 'allowed-paths-remote-'));
    try {
      execSync('git init -q --bare', { cwd: remote });
      sh(`git push -q ${remote} ${base}:refs/heads/main`);
      sh(`git push -q ${remote} auto/x:refs/heads/old`);
      const old = execSync(`git diff --name-only main refs/heads/old`, {
        cwd: remote,
        encoding: 'utf8',
      });
      expect(old).toContain('ci.yml');
      // Pushing exactly the checked sha carries only the catalog.
      sh(`git push -q ${remote} ${pushRefspec('auto/x', sha)}`);
      const pushed = execSync(`git diff --name-only main refs/heads/auto/x`, {
        cwd: remote,
        encoding: 'utf8',
      });
      expect(pushed.trim()).toBe('catalog.ts');
    } finally {
      rmSync(remote, { force: true, recursive: true });
    }
  });

  it('builds `<sha>:refs/heads/<branch>` when guarded and the original `<branch>` when not', () => {
    const sha = 'a'.repeat(40);
    expect(pushRefspec("auto/it's", sha)).toBe(`${sha}:refs/heads/'auto/it'\\''s'`);
    expect(pushRefspec('auto/x', undefined)).toBe("'auto/x'");
  });

  it('reports the pushed commit, not HEAD', async () => {
    const base = sh('git rev-parse HEAD').trim();
    const guard = await startPathGuard(workspace, 'main', ALLOWED);
    write('ci.yml', 'name: pwned\n');
    sh('git add -A && git commit -q -m sneaky');
    sh(`git checkout -q -b scratch ${base}`);
    write('catalog.ts', 'export const BUILTIN_MODELS = [2];\n');
    sh('git add -A');
    const sha = (await commitStaged(workspace, 'auto: implement', guard)) as string;
    sh('git checkout -q auto/x');
    // HEAD is now the sneaky branch; the report still reads the checked commit.
    const diff = await diffForResult(workspace, 'main', guard, sha);
    expect(diff).toContain('catalog.ts');
    expect(diff).not.toContain('ci.yml');
  });

  it('finds a gitlink even when the repository config says to ignore submodules', async () => {
    await expect(
      runGuarded(() => {
        write('catalog.ts', 'export const BUILTIN_MODELS = [3];\n');
        sh('git config diff.ignoreSubmodules all');
        // A nested repository is staged by `git add -A` as a gitlink.
        sh(
          'git init -q vendor/sub && git -C vendor/sub -c user.name=t -c user.email=t@t commit -q --allow-empty -m s'
        );
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining('vendor/sub'),
      type: 'DIFF_OUTSIDE_ALLOWED_PATHS',
    });
  });
});

describe('what the step reports (cumulative)', () => {
  it('uses the original run base, as two trees, when it is supplied', async () => {
    const original = sh('git rev-parse HEAD').trim();
    write('catalog.ts', 'export const BUILTIN_MODELS = [1];\n');
    sh('git commit -qam first');
    const guard = await startPathGuard(workspace, 'main', ALLOWED, original);
    write('catalog.ts', 'export const BUILTIN_MODELS = [2];\n');
    sh('git add -A');
    const sha = await commitStaged(workspace, 'auto: fix', guard);
    // Even with origin/main dragged forward by the agent, the report covers both sessions.
    sh('git update-ref refs/remotes/origin/main HEAD');
    const diff = await diffForResult(workspace, 'main', guard, sha);
    expect(diff).toContain('[2]');
    expect(diff).toContain('diff --git a/catalog.ts b/catalog.ts');
  });

  it('falls back to the recorded default-branch sha, never the ref, when no base is carried', async () => {
    write('catalog.ts', 'export const BUILTIN_MODELS = [1];\n');
    sh('git commit -qam first');
    const guard = await startPathGuard(workspace, 'main', ALLOWED);
    expect(guard?.report.sha).toBe(sh('git rev-parse refs/remotes/origin/main').trim());
    sh('git update-ref refs/remotes/origin/main HEAD');
    write('catalog.ts', 'export const BUILTIN_MODELS = [2];\n');
    sh('git add -A');
    const sha = await commitStaged(workspace, 'auto: fix', guard);
    // The branch carried a commit ahead of the default tip: reported as a merge-base range.
    expect(await diffForResult(workspace, 'main', guard, sha)).toContain('catalog.ts');
  });
});

describe('what the step reports', () => {
  it('derives the diff from the starting commit, ignoring a moved origin/<default>', async () => {
    const guard = await startPathGuard(workspace, 'main', ALLOWED);
    write('catalog.ts', 'export const BUILTIN_MODELS = [8];\n');
    write('ci.yml', 'name: pwned\n');
    sh('git add -A && git commit -q -m sneaky && git update-ref refs/remotes/origin/main HEAD');
    const diff = await diffForResult(workspace, 'main', guard, sh('git rev-parse HEAD').trim());
    expect(diff).toContain('diff --git a/ci.yml b/ci.yml');
    // The unguarded command is the original one and would have been fooled.
    expect(await diffForResult(workspace, 'main', undefined)).toBe('');
  });
});

describe('with no allowedPaths', () => {
  it('starts no guard and runs the original commands', async () => {
    const seen: string[] = [];
    const ws = {
      exec: async (cmd: string) => {
        seen.push(cmd);
        return '';
      },
    };
    expect(await startPathGuard(ws, 'main', undefined)).toBeUndefined();
    await commitStaged(ws, "it's", undefined);
    await diffForResult(ws, 'main', undefined);
    expect(seen).toEqual([
      "git diff --cached --quiet || git commit -m 'it'\\''s'",
      "git diff origin/'main'",
    ]);
  });
});

describe('startPathGuard', () => {
  it('fails closed, non-retryably, when the starting commit cannot be read', async () => {
    const ws = {
      exec: async () => {
        throw new Error('no such ref');
      },
    };
    await expect(startPathGuard(ws, 'main', ALLOWED)).rejects.toMatchObject({
      nonRetryable: true,
      type: 'DIFF_BASE_UNREADABLE',
    });
  });
});

describe('the workflow-change refusal (refuseWorkflowChanges)', () => {
  async function runRefusing(agent: () => void, allowed?: string[]): Promise<string | undefined> {
    const guard = await startPathGuard(workspace, 'main', allowed, undefined, {
      refuseWorkflowChanges: true,
    });
    expect(guard).toBeDefined();
    agent();
    sh('git add -A');
    return commitStaged(workspace, 'auto: fix', guard);
  }

  it('guards a step with no allowed-paths list at all', async () => {
    await expect(startPathGuard(workspace, 'main', undefined)).resolves.toBeUndefined();
    const sha = await runRefusing(() => write('src/sum.ts', 'export const sum = 1;\n'));
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(pushedFiles()).toBe('src/sum.ts');
  });

  it.each([
    ['a workflow file', '.github/workflows/ci.yml'],
    ['a composite action', '.github/actions/setup/action.yml'],
    ['an upper-case spelling', '.GitHub/Workflows/ci.yml'],
  ])('refuses %s before the push', async (_label, file) => {
    await expect(runRefusing(() => write(file, 'on: push\n'))).rejects.toMatchObject({
      type: 'DIFF_TOUCHES_WORKFLOWS',
    });
  });

  it('refuses a symlink, which could point a checked path at content the check never read', async () => {
    await expect(
      runRefusing(() => {
        mkdirSync(path.join(dir, '.github'), { recursive: true });
        sh('ln -s ../tools .github/workflows');
      })
    ).rejects.toMatchObject({ type: 'DIFF_TOUCHES_WORKFLOWS' });
  });

  it('refuses a submodule', async () => {
    await expect(
      runRefusing(() =>
        sh(
          'git init -q vendor/sub && git -C vendor/sub -c user.name=t -c user.email=t@t commit -q --allow-empty -m s'
        )
      )
    ).rejects.toMatchObject({ type: 'DIFF_TOUCHES_WORKFLOWS' });
  });

  it('still applies an allowed-paths list alongside it', async () => {
    await expect(runRefusing(() => write('other.ts', 'x\n'), ['catalog.ts'])).rejects.toMatchObject(
      { type: 'DIFF_OUTSIDE_ALLOWED_PATHS' }
    );
  });
});
