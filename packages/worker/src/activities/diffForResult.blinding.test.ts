/**
 * The diff the security gate, the code scanner and the reviewers read, against real git. An agent
 * controls its own checkout, so every way it can make `git diff` print less than it committed is
 * carried out for real here, for the unguarded and the guarded step alike, and the text the
 * scanners would receive must still hold the payload. Each route also has a control: the logic the
 * gate used before (a copy, below) is blinded by it, which is what shows the test can fail.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApplicationFailure } from '@temporalio/activity';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitStaged, diffForResult, type PathGuard, startPathGuard } from './allowedPaths.js';
import { withEndMarker } from './pinnedGitTestSupport.js';

let parent: string;
let dir: string;
const sh = (cmd: string): string =>
  execSync(cmd, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    maxBuffer: 64 * 1024 * 1024,
    shell: '/bin/sh',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const workspace = { exec: async (cmd: string) => sh(cmd) };
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};

const PAYLOAD = 'eval(userInput); const key = "AKIAIOSFODNN7EXAMPLE";\n';

/** The logic before the fix: the work-tree porcelain diff (unguarded) / the committed range. */
async function oldDiffForResult(mode: Mode, guard: PathGuard, pushSha: string): Promise<string> {
  if (mode === 'unguarded') {
    return workspace.exec('git diff origin/main');
  }
  return workspace.exec(
    `git -c core.attributesFile=/dev/null diff --no-ext-diff --no-textconv --ignore-submodules=none ${guard.report.sha} ${pushSha}`
  );
}

beforeEach(() => {
  parent = mkdtempSync(path.join(tmpdir(), 'diff-blinding-'));
  dir = path.join(parent, 'target-repo');
  mkdirSync(dir);
  sh('git init -q -b main && git config user.name t && git config user.email t@t');
  write('README.md', '# base\n');
  sh('git add -A && git commit -q -m base && git update-ref refs/remotes/origin/main HEAD');
});
afterEach(() => rmSync(parent, { force: true, recursive: true }));

/** Whether the step set `allowedPaths`; either way it records its base and commits the same way. */
type Mode = 'unguarded' | 'guarded';

/** Commit the payload the way a step would, then let `blind` tamper with the checkout. */
async function run(mode: Mode, blind: () => void) {
  const guard = await startPathGuard(
    workspace,
    'main',
    mode === 'guarded' ? ['evil.js', '.gitattributes'] : undefined
  );
  write('evil.js', PAYLOAD);
  sh('git add -A');
  const pushSha = await commitStaged(workspace, 'auto: implement', guard);
  blind();
  return { guard, pushSha };
}

const routes: Array<{ name: string; blind: () => void; oldBlinded: Record<Mode, boolean> }> = [
  {
    blind: () => sh('git config diff.external /bin/true'),
    name: 'an external diff driver (diff.external)',
    // The guarded range passed --no-ext-diff already.
    oldBlinded: { guarded: false, unguarded: true },
  },
  {
    blind: () => {
      sh('git config diff.x.textconv /bin/true');
      write('.git/info/attributes', '* diff=x\n');
    },
    name: 'a textconv driver selected from .git/info/attributes',
    oldBlinded: { guarded: false, unguarded: true },
  },
  {
    blind: () => write('.git/info/attributes', '* -diff\n'),
    name: '-diff in .git/info/attributes (never committed)',
    oldBlinded: { guarded: true, unguarded: true },
  },
  {
    blind: () => {
      write('.gitattributes', '* -diff\n');
      sh('git add -A && git commit -q --amend --no-edit');
    },
    name: '-diff in a committed .gitattributes',
    oldBlinded: { guarded: true, unguarded: true },
  },
  {
    blind: () => write('.git/info/attributes', '* binary\n'),
    name: 'a binary attribute in .git/info/attributes',
    oldBlinded: { guarded: true, unguarded: true },
  },
  {
    blind: () => {
      sh('git config core.hooksPath /dev/null');
      sh('git config core.worktree "$(dirname "$(pwd)")"');
    },
    name: 'a work tree moved to an ancestor (core.worktree) with hooks off',
    oldBlinded: { guarded: false, unguarded: true },
  },
];

describe.each(routes)('$name', ({ blind, oldBlinded }) => {
  describe.each(['unguarded', 'guarded'] as const)('%s step', (mode) => {
    it('control: the previous logic is blinded where it was', async () => {
      const { guard, pushSha } = await run(mode, blind);
      const old = await oldDiffForResult(mode, guard, pushSha);
      if (oldBlinded[mode]) {
        expect(old).not.toContain('eval(');
      }
    });

    it('the scanner input still holds the eval( call and the key', async () => {
      const { guard, pushSha } = await run(mode, blind);
      const diff = await diffForResult(workspace, guard, pushSha);
      expect(diff).toContain('diff --git a/evil.js b/evil.js');
      expect(diff).toContain('+eval(userInput)');
      expect(diff).toContain('AKIAIOSFODNN7EXAMPLE');
    });
  });
});

describe('what stays in the scan input', () => {
  it('keeps a lockfile-named file: a secret can hide in one', async () => {
    const { guard } = await run('guarded', () => {});
    write('yarn.lock', 'token = "AKIAIOSFODNN7EXAMPLE"\n');
    sh('git add -A && git commit -q -m lock');
    const sha = sh('git rev-parse HEAD').trim();
    const diff = await diffForResult(workspace, guard, sha);
    expect(diff).toContain('diff --git a/yarn.lock b/yarn.lock');
    expect(diff).toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('is empty when nothing changed', async () => {
    const guard = await startPathGuard(workspace, 'main', undefined);
    expect(await diffForResult(workspace, guard, sh('git rev-parse HEAD').trim())).toBe('');
  });
});

describe('an empty diff for a different tree', () => {
  /** Something below the analyser hides the patch but not the tree listing. */
  const blinded = {
    exec: async (cmd: string) => (cmd.includes(' -p --text') ? withEndMarker(cmd, '') : sh(cmd)),
  };

  it.each(['unguarded', 'guarded'] as const)('fails closed, non-retryably (%s)', async (mode) => {
    const { guard, pushSha } = await run(mode, () => {});
    const failure = await diffForResult(blinded, guard, pushSha).then(
      () => undefined,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect((failure as ApplicationFailure).type).toBe('SECURITY_GATE_UNAVAILABLE');
    expect((failure as ApplicationFailure).nonRetryable).toBe(true);
  });

  it('fails closed, before the agent runs, when the base cannot be read', async () => {
    sh('git update-ref -d refs/remotes/origin/main');
    await expect(startPathGuard(workspace, 'main', undefined)).rejects.toMatchObject({
      type: 'DIFF_BASE_UNREADABLE',
    });
  });
});
