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
  assertCommittedRangeWithinAllowedPaths,
  commitStaged,
  diffForResult,
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

async function runGuarded(agent: () => void): Promise<void> {
  const guard = await startPathGuard(workspace, 'main', ALLOWED);
  expect(guard).toBeDefined();
  agent();
  sh('git add -A');
  await commitStaged(workspace, 'auto: implement', guard);
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

  it('fails a branch that was rewritten to share no history with the starting commit', async () => {
    await expect(
      runGuarded(() => {
        sh('git checkout -q --orphan fresh');
        write('catalog.ts', 'export const BUILTIN_MODELS = [5];\n');
      })
    ).rejects.toMatchObject({ nonRetryable: true, type: 'DIFF_BASE_UNRELATED' });
  });

  it('catches an out-of-scope file the agent committed itself, from any commit in the range', async () => {
    await expect(
      runGuarded(() => {
        write('package.json', '{}\n');
        sh('git add -A && git commit -q -m one');
        sh('git rm -q package.json && git commit -q -m two');
        write('catalog.ts', 'export const BUILTIN_MODELS = [6];\n');
      })
    ).resolves.toBeUndefined();
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
    await commitStaged(workspace, 'auto: implement', guard);
    await expect(
      assertCommittedRangeWithinAllowedPaths(workspace, guard as NonNullable<typeof guard>)
    ).resolves.toBeUndefined();
  });
});

describe('what the step reports', () => {
  it('derives the diff from the starting commit, ignoring a moved origin/<default>', async () => {
    const guard = await startPathGuard(workspace, 'main', ALLOWED);
    write('catalog.ts', 'export const BUILTIN_MODELS = [8];\n');
    write('ci.yml', 'name: pwned\n');
    sh('git add -A && git commit -q -m sneaky && git update-ref refs/remotes/origin/main HEAD');
    const diff = await diffForResult(workspace, 'main', guard);
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
