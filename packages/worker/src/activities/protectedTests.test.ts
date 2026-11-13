import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));

import { shellQuote } from '../lib/shellQuote.js';
import { withEndMarker } from './pinnedGitTestSupport.js';
import {
  chunkPaths,
  isProtectedTestPath,
  PROTECTED_TESTS_UNAVAILABLE,
  parseNameStatusZ,
  restoreProtectedTests,
  selectProtectedChanges,
} from './protectedTests.js';

// ── Classification ───────────────────────────────────────────────────────────────────────────────

describe('which paths are protected', () => {
  it.each([
    'src/a.test.ts',
    'src/__tests__/a.ts',
    'tests/unit/a.spec.js',
    'pkg/server_test.go',
    'tests/fixtures/data.json',
    'src/__snapshots__/a.snap',
    'conftest.py',
    'jest.config.js',
    'vitest.config.ts',
    'packages/web/playwright.config.ts',
    'pytest.ini',
    '.mocharc.json',
    'phpunit.xml',
    'src/test/java/com/acme/FooTest.java',
  ])('protects %s', (p) => {
    expect(isProtectedTestPath(p)).toBe(true);
  });

  it.each([
    // The upgrade itself lives in these: they are never put back.
    'package.json',
    'package-lock.json',
    'go.mod',
    'go.sum',
    'pom.xml',
    'build.gradle',
    'pyproject.toml',
    'Cargo.toml',
    'yarn.lock',
    'tsconfig.json',
    'src/a.ts',
    'src/server.go',
    'README.md',
    '.github/workflows/ci.yml',
  ])('never restores %s', (p) => {
    expect(isProtectedTestPath(p)).toBe(false);
  });
});

describe('selectProtectedChanges', () => {
  it('restores modified, deleted and type-changed protected paths and removes added ones', () => {
    const changes = parseNameStatusZ(
      [
        'M',
        'src/a.test.ts',
        'D',
        'src/b.test.ts',
        'T',
        'tests/x.json',
        'A',
        'src/new.test.ts',
        'M',
        'package.json',
        'M',
        'go.mod',
        'A',
        'src/impl.ts',
        'M',
        'pom.xml',
        '',
      ].join('\0')
    );
    expect(selectProtectedChanges(changes)).toEqual({
      remove: ['src/new.test.ts'],
      restore: ['src/a.test.ts', 'src/b.test.ts', 'tests/x.json'],
    });
  });

  it('parses names with spaces, newlines and a leading dash literally', () => {
    const odd = 'tests/it has\nnewline -rf.test.ts';
    const out = parseNameStatusZ(`M\0${odd}\0`);
    expect(out).toEqual([{ path: odd, status: 'M' }]);
    expect(selectProtectedChanges(out).restore).toEqual([odd]);
  });

  it('rejects output it cannot read rather than guessing', () => {
    expect(() => parseNameStatusZ('M\0a\0D\0')).toThrow();
    expect(() => parseNameStatusZ('R100\0a\0b\0')).toThrow();
    expect(() => parseNameStatusZ('X\0a\0')).toThrow();
    expect(() => parseNameStatusZ('M\0\0')).toThrow();
  });

  it('chunks long path lists', () => {
    const many = Array.from({ length: 3000 }, (_, i) => `tests/${'x'.repeat(40)}${i}.test.ts`);
    const chunks = chunkPaths(many);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(many);
    for (const c of chunks) {
      expect(c.join(' ').length).toBeLessThan(31_000);
    }
    expect(chunkPaths([])).toEqual([]);
  });
});

// ── With the exec mocked ─────────────────────────────────────────────────────────────────────────

describe('restoreProtectedTests with exec mocked', () => {
  const BASE = 'a'.repeat(40);
  const HEAD = 'b'.repeat(40);

  const TARGET = { baseBranch: 'main', baseSha: BASE, branch: 'auto/x' } as const;

  function fake(
    opts: { missingBase?: boolean; changes?: string; failOn?: RegExp; truncate?: boolean } = {}
  ) {
    const commands: string[] = [];
    const exec = vi.fn(async (command: string) => {
      commands.push(command);
      if (opts.failOn?.test(command)) {
        throw new Error('boom');
      }
      if (command.includes('cat-file -e')) {
        if (opts.missingBase) {
          throw new Error('missing');
        }
        return '';
      }
      if (command.includes('rev-parse --verify')) {
        return `${HEAD}\n`;
      }
      if (command.includes('diff-tree')) {
        return opts.truncate ? (opts.changes ?? '') : withEndMarker(command, opts.changes ?? '');
      }
      return '';
    });
    const gitAuthed = vi.fn(async (sub: string) => {
      commands.push(`gitAuthed ${sub}`);
      return '';
    });
    return { commands, exec, gitAuthed };
  }

  it('throws PROTECTED_TESTS_UNAVAILABLE, non-retryable, without a recorded base', async () => {
    const f = fake();
    const err = await restoreProtectedTests(f, { baseBranch: 'main', branch: 'auto/x' }).catch(
      (e) => e
    );
    expect(err.type).toBe(PROTECTED_TESTS_UNAVAILABLE);
    expect(err.nonRetryable).toBe(true);
    // Nothing was read to choose a base in its place.
    expect(f.commands).toEqual([]);
  });

  it('computes no merge base: the recorded sha is the base', async () => {
    const f = fake({ changes: 'M\0src/a.test.ts\0' });
    const report = await restoreProtectedTests(f, TARGET);
    expect(report.base).toBe(BASE);
    expect(f.commands.some((c) => c.includes('merge-base'))).toBe(false);
    // A two-tree comparison of the recorded base and the tip.
    expect(f.commands.some((c) => c.includes(`diff-tree`) && c.includes(`${BASE} ${HEAD}`))).toBe(
      true
    );
  });

  it('deepens the history, then fails closed, when the recorded base is not in the clone', async () => {
    const f = fake({ missingBase: true });
    const err = await restoreProtectedTests(f, TARGET).catch((e) => e);
    expect(err.type).toBe(PROTECTED_TESTS_UNAVAILABLE);
    expect(err.nonRetryable).toBe(true);
    expect(f.gitAuthed).toHaveBeenCalled();
    expect(String(f.gitAuthed.mock.calls[0]?.[0])).toContain('--deepen=');
  });

  it('refuses a branch tip that is not the commit the change reported', async () => {
    const f = fake({ changes: 'M\0src/a.test.ts\0' });
    const err = await restoreProtectedTests(f, { ...TARGET, headSha: 'c'.repeat(40) }).catch(
      (e) => e
    );
    expect(err.type).toBe(PROTECTED_TESTS_UNAVAILABLE);
    expect(f.commands.some((c) => c.includes('checkout-index'))).toBe(false);
  });

  it('accepts the tip when it is the reported commit', async () => {
    const f = fake({ changes: 'M\0src/a.test.ts\0' });
    const report = await restoreProtectedTests(f, { ...TARGET, headSha: HEAD });
    expect(report.restored).toEqual(['src/a.test.ts']);
  });

  it('fails closed when the changed-path list was cut short', async () => {
    const f = fake({ changes: 'M\0src/a.test.ts\0', truncate: true });
    const err = await restoreProtectedTests(f, TARGET).catch((e) => e);
    expect(err.type).toBe(PROTECTED_TESTS_UNAVAILABLE);
    expect(f.commands.some((c) => c.includes('checkout-index'))).toBe(false);
  });

  it('fails closed when the changed paths cannot be read', async () => {
    const f = fake({ failOn: /diff-tree/ });
    const err = await restoreProtectedTests(f, TARGET).catch((e) => e);
    expect(err.type).toBe(PROTECTED_TESTS_UNAVAILABLE);
  });

  it('fails closed when a restore command fails', async () => {
    const f = fake({ changes: 'M\0src/a.test.ts\0', failOn: /checkout-index/ });
    const err = await restoreProtectedTests(f, TARGET).catch((e) => e);
    expect(err.type).toBe(PROTECTED_TESTS_UNAVAILABLE);
  });

  it('runs nothing that writes when no protected path changed', async () => {
    const f = fake({ changes: 'M\0package.json\0M\0go.mod\0A\0src/impl.ts\0' });
    const report = await restoreProtectedTests(f, TARGET);
    expect(report.restored).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(f.commands.some((c) => /checkout-index|\brm\b/.test(c))).toBe(false);
    expect(report.summary).toMatch(/no test files differed/);
  });

  it('pins every git call to a git directory and work tree, and hardens it', async () => {
    const f = fake({ changes: 'M\0src/a.test.ts\0A\0src/n.test.ts\0' });
    await restoreProtectedTests(f, TARGET);
    const gitCalls = f.commands.filter((c) => /\bgit\b/.test(c) && !c.startsWith('gitAuthed'));
    expect(gitCalls.length).toBeGreaterThan(3);
    for (const c of gitCalls) {
      expect(c, c).toMatch(/GIT_DIR=/);
      expect(c, c).toMatch(/GIT_WORK_TREE=/);
      expect(c, c).toContain('GIT_NO_REPLACE_OBJECTS=1');
      expect(c, c).toContain('GIT_GRAFT_FILE=/dev/null');
      expect(c, c).toContain('GIT_LITERAL_PATHSPECS=1');
      expect(c, c).toContain('GIT_CONFIG_NOSYSTEM=1');
      expect(c, c).toContain('GIT_CONFIG_GLOBAL=/dev/null');
      expect(c, c).toContain('core.hooksPath=/dev/null');
      expect(c, c).toContain('core.fsmonitor=false');
      expect(c, c).toContain('core.attributesFile=/dev/null');
    }
  });

  it('writes only through a pristine git directory, never the checkout’s own .git', async () => {
    const f = fake({ changes: 'M\0src/a.test.ts\0A\0src/n.test.ts\0' });
    await restoreProtectedTests(f, TARGET);
    const writers = f.commands.filter((c) => /checkout-index|\brm -f\b/.test(c));
    expect(writers).toHaveLength(2);
    for (const c of writers) {
      expect(c).toContain('GIT_DIR="$T/g"');
      expect(c).toContain('GIT_OBJECT_DIRECTORY="$REPO/.git/objects"');
      expect(c).not.toMatch(/GIT_DIR="\$\(pwd -P\)\/\.git"/);
    }
  });

  it('quotes every path, and ends option parsing before them', async () => {
    const hostile = [
      "tests/a'; touch pwned; '.test.ts",
      'tests/$(id).test.ts',
      'tests/-rf.test.ts',
    ];
    const f = fake({ changes: hostile.map((p) => `M\0${p}\0`).join('') });
    await restoreProtectedTests(f, TARGET);
    const restore = f.commands.find((c) => c.includes('checkout-index')) ?? '';
    expect(restore).toContain("'tests/$(id).test.ts'");
    expect(restore).toContain("'tests/-rf.test.ts'");
    expect(restore).toContain(`'tests/a'\\''; touch pwned; '\\''.test.ts'`);
    // Each path appears exactly as the shell quotes it, so the real-git test below (which runs the
    // hostile names) exercises what this text says.
    for (const p of hostile) {
      expect(restore).toContain(shellQuote(p));
    }
  });

  it('records at most 50 paths on the event and the full counts', async () => {
    const changes = Array.from({ length: 80 }, (_, i) => `M\0src/f${i}.test.ts\0`).join('');
    const f = fake({ changes });
    const report = await restoreProtectedTests(f, TARGET);
    expect(report.restored).toHaveLength(80);
    expect(report.event.restored).toHaveLength(50);
    expect(report.event.restoredCount).toBe(80);
    expect(report.summary).toBe(`restored 80 test files from ${BASE.slice(0, 8)}`);
  });
});

// ── Against real git ─────────────────────────────────────────────────────────────────────────────

let dir: string;

const GIT_ENV = {
  GIT_AUTHOR_EMAIL: 'a@example.test',
  GIT_AUTHOR_NAME: 'a',
  GIT_COMMITTER_EMAIL: 'a@example.test',
  GIT_COMMITTER_NAME: 'a',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  HOME: '/nonexistent',
};

function sh(cwd: string, cmd: string): string {
  const r = spawnSync('sh', ['-c', cmd], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: dir, ...GIT_ENV },
  });
  if (r.status !== 0) {
    throw new Error(`${cmd}\n${r.stderr}`);
  }
  return r.stdout;
}

const git = (cwd: string, args: string) =>
  sh(cwd, `git -c protocol.file.allow=always -c init.defaultBranch=main ${args}`);

function write(repo: string, path: string, content: string, mode?: number) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
  if (mode) {
    chmodSync(join(repo, path), mode);
  }
}

const read = (repo: string, path: string) => readFileSync(join(repo, path), 'utf8');

interface Fixture {
  gate: string;
  marker: string;
  elsewhere: string;
  /** The commit the branch was cut from, as the change's code result records it. */
  base: string;
}

/**
 * origin with `main` and a branch `auto/x` cut from an older main (so the base has moved on),
 * and a "gate" clone checked out the way `provisionGateWorkspace` does it: a shallow clone of the
 * base, the branch fetched, `reset --hard` to it.
 */
function build(extraInTree: Record<string, string> = {}): Fixture {
  const work = join(dir, 'work');
  const origin = join(dir, 'origin.git');
  mkdirSync(work);
  git(dir, `init -q --bare ${origin}`);
  git(work, 'init -q');
  git(work, `remote add origin ${origin}`);

  write(work, 'package.json', '{"name":"x","dependencies":{"lodash":"^4.17.20"}}\n');
  write(work, 'package-lock.json', '{"v":1}\n');
  write(work, 'go.mod', 'module x\n');
  write(work, 'pom.xml', '<project>1</project>\n');
  write(work, 'src/a.ts', 'export const a = 1;\n');
  write(work, 'src/a.test.ts', "test('a', () => expect(1).toBe(1));\n");
  write(work, 'src/b.test.ts', "test('b', () => expect(2).toBe(2));\n");
  write(work, 'tests/fixtures/data.json', '{"original":true}\n');
  write(work, 'tests/run.sh', '#!/bin/sh\necho original\n', 0o755);
  write(work, 'src/__snapshots__/a.snap', 'original snapshot\n');
  write(work, 'jest.config.js', 'module.exports = { testMatch: ["**/*.test.ts"] };\n');
  write(work, '.gitattributes', '* filter=evil\n');
  for (const [p, c] of Object.entries(extraInTree)) {
    write(work, p, c);
  }
  git(work, 'add -A');
  git(work, 'commit -q -m base');
  git(work, 'push -q origin HEAD:refs/heads/main');
  git(work, 'branch -M main');

  // The branch: the upgrade, plus every way of getting tests out of the way.
  git(work, 'checkout -q -b auto/x');
  write(
    work,
    'package.json',
    '{"name":"x","dependencies":{"lodash":"^4.17.21"},"scripts":{"test":"true"}}\n'
  );
  write(work, 'package-lock.json', '{"v":2}\n');
  write(work, 'go.mod', 'module x\n\ngo 1.22\n');
  write(work, 'pom.xml', '<project>2</project>\n');
  write(work, 'src/a.ts', 'export const a = 2;\n');
  write(work, 'src/a.test.ts', "test.skip('a', () => {});\n");
  rmSync(join(work, 'src/b.test.ts'));
  write(work, 'tests/fixtures/data.json', '{"original":false}\n');
  write(work, 'tests/run.sh', '#!/bin/sh\necho tampered\n', 0o644);
  rmSync(join(work, 'src/__snapshots__/a.snap'));
  write(work, 'jest.config.js', 'module.exports = { testMatch: [] };\n');
  write(work, 'src/new.test.ts', "test('new', () => {});\n");
  write(work, 'src/impl.ts', 'export const impl = 1;\n');
  git(work, 'add -A');
  git(work, 'commit -q -m upgrade');
  git(work, 'push -q origin HEAD:refs/heads/auto/x');

  // The base moves on after the branch was cut.
  git(work, 'checkout -q main');
  write(work, 'src/later.ts', 'export const later = 1;\n');
  git(work, 'add -A');
  git(work, 'commit -q -m later');
  git(work, 'push -q origin HEAD:refs/heads/main');

  const gate = join(dir, 'gate');
  git(dir, `clone -q --depth=50 -b main file://${origin} ${gate}`);
  git(gate, 'fetch -q origin +refs/heads/auto/x:refs/remotes/origin/auto/x');
  git(gate, 'reset -q --hard origin/auto/x');
  const base = git(gate, 'rev-parse origin/auto/x^').trim();
  return { base, elsewhere: join(dir, 'elsewhere'), gate, marker: join(dir, 'EVIL_MARKER') };
}

/** A Workspace whose `exec` runs in the gate checkout, as the container's `exec` does. */
function liveWorkspace(cwd: string) {
  return {
    exec: async (command: string) => sh(cwd, command),
    gitAuthed: async (sub: string) => git(cwd, sub),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'protected-'));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe('restoreProtectedTests against real git', () => {
  it('puts the originals back and leaves the upgrade and the source alone', async () => {
    const { base, gate } = build();
    const report = await restoreProtectedTests(liveWorkspace(gate), {
      baseBranch: 'main',
      baseSha: base,
      branch: 'auto/x',
    });

    // Tests, support files, snapshots and the pure test-runner config are the base's.
    expect(read(gate, 'src/a.test.ts')).toBe("test('a', () => expect(1).toBe(1));\n");
    expect(read(gate, 'src/b.test.ts')).toBe("test('b', () => expect(2).toBe(2));\n");
    expect(read(gate, 'tests/fixtures/data.json')).toBe('{"original":true}\n');
    expect(read(gate, 'src/__snapshots__/a.snap')).toBe('original snapshot\n');
    expect(read(gate, 'jest.config.js')).toBe(
      'module.exports = { testMatch: ["**/*.test.ts"] };\n'
    );
    // The executable bit comes back with the content.
    expect(read(gate, 'tests/run.sh')).toContain('original');
    expect(statSync(join(gate, 'tests/run.sh')).mode & 0o111).not.toBe(0);
    // A test file the change added is gone for this run.
    expect(existsSync(join(gate, 'src/new.test.ts'))).toBe(false);

    // The upgrade, and the code under test, stay as the branch has them.
    expect(read(gate, 'package.json')).toContain('"scripts":{"test":"true"}');
    expect(read(gate, 'package-lock.json')).toBe('{"v":2}\n');
    expect(read(gate, 'go.mod')).toBe('module x\n\ngo 1.22\n');
    expect(read(gate, 'pom.xml')).toBe('<project>2</project>\n');
    expect(read(gate, 'src/a.ts')).toBe('export const a = 2;\n');
    expect(read(gate, 'src/impl.ts')).toBe('export const impl = 1;\n');
    // Restored from the commit the branch was cut from, not the moved-on base tip.
    expect(existsSync(join(gate, 'src/later.ts'))).toBe(false);

    expect(report.restored.sort()).toEqual([
      'jest.config.js',
      'src/__snapshots__/a.snap',
      'src/a.test.ts',
      'src/b.test.ts',
      'tests/fixtures/data.json',
      'tests/run.sh',
    ]);
    expect(report.removed).toEqual(['src/new.test.ts']);
    expect(report.summary).toBe(
      `restored 6 test files from ${report.base.slice(0, 8)} and removed 1 added by the change`
    );
  });

  it('never touches the branch: nothing is committed, the pushed commit is unchanged', async () => {
    const { base, gate } = build();
    const before = git(gate, 'rev-parse HEAD').trim();
    await restoreProtectedTests(liveWorkspace(gate), {
      baseBranch: 'main',
      baseSha: base,
      branch: 'auto/x',
    });
    expect(git(gate, 'rev-parse HEAD').trim()).toBe(before);
    expect(git(gate, 'log --format=%s -1').trim()).toBe('upgrade');
  });

  it('is inert under a hostile checkout config: filters, hooks, fsmonitor, core.worktree, info/attributes', async () => {
    const { base, gate, marker, elsewhere } = build();
    mkdirSync(elsewhere);
    mkdirSync(join(dir, 'hooks'));
    for (const hook of ['post-checkout', 'post-index-change', 'reference-transaction']) {
      writeFileSync(join(dir, 'hooks', hook), `#!/bin/sh\ntouch '${marker}'\n`);
      chmodSync(join(dir, 'hooks', hook), 0o755);
    }
    writeFileSync(join(dir, 'fsmonitor.sh'), `#!/bin/sh\ntouch '${marker}'\nprintf '\\0'\n`);
    chmodSync(join(dir, 'fsmonitor.sh'), 0o755);
    const cfg = join(gate, '.git/config');
    writeFileSync(
      cfg,
      `${readFileSync(cfg, 'utf8')}
[filter "evil"]
\tsmudge = touch '${marker}'; cat
\tclean = touch '${marker}'; cat
\trequired = true
[core]
\tworktree = ${elsewhere}
\thooksPath = ${join(dir, 'hooks')}
\tfsmonitor = ${join(dir, 'fsmonitor.sh')}
\tautocrlf = true
\tattributesFile = ${join(dir, 'attrs')}
[diff]
\tignoreSubmodules = all
[include]
\tpath = ${join(dir, 'more-config')}
`
    );
    writeFileSync(join(dir, 'more-config'), `[filter "evil"]\n\tsmudge = touch '${marker}'\n`);
    mkdirSync(join(gate, '.git/info'), { recursive: true });
    writeFileSync(
      join(gate, '.git/info/attributes'),
      '* filter=evil\n* -diff\n*.test.ts text eol=crlf\n'
    );
    writeFileSync(join(dir, 'attrs'), '* filter=evil\n');

    const report = await restoreProtectedTests(liveWorkspace(gate), {
      baseBranch: 'main',
      baseSha: base,
      branch: 'auto/x',
    });

    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
    // Restored into the real checkout, byte for byte: no CRLF from the planted attributes.
    expect(read(gate, 'src/a.test.ts')).toBe("test('a', () => expect(1).toBe(1));\n");
    expect(read(gate, 'jest.config.js')).toBe(
      'module.exports = { testMatch: ["**/*.test.ts"] };\n'
    );
    expect(existsSync(join(gate, 'src/new.test.ts'))).toBe(false);
    expect(report.restored).toContain('src/a.test.ts');
  });

  it('is inert when the tracked .gitattributes names a filter and a worktree-moving config exists', async () => {
    // build() already tracks `* filter=evil`. With no driver defined it must stay a no-op, and a
    // `.git` file pointing elsewhere must not redirect the writes either.
    const { base, gate, marker } = build();
    await restoreProtectedTests(liveWorkspace(gate), {
      baseBranch: 'main',
      baseSha: base,
      branch: 'auto/x',
    });
    expect(existsSync(marker)).toBe(false);
    expect(read(gate, 'src/a.test.ts')).toBe("test('a', () => expect(1).toBe(1));\n");
  });

  it('does not write through a symlinked directory the change introduced', async () => {
    const { base, gate } = build();
    // The branch replaced the support directory with a symlink to somewhere outside the checkout.
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'data.json'), 'outside\n');
    rmSync(join(gate, 'tests/fixtures'), { force: true, recursive: true });
    symlinkSync(outside, join(gate, 'tests/fixtures'));
    git(gate, 'add -A tests');
    git(gate, 'commit -q -m symlink');
    await restoreProtectedTests(liveWorkspace(gate), {
      baseBranch: 'main',
      baseSha: base,
      branch: 'auto/x',
    }).catch(() => undefined);
    // Whatever the outcome for the run, the file outside the checkout was not written or removed.
    expect(readFileSync(join(outside, 'data.json'), 'utf8')).toBe('outside\n');
  });

  it('restores a file the change replaced with a symlink', async () => {
    const { base, gate } = build();
    rmSync(join(gate, 'src/a.test.ts'));
    symlinkSync('/etc/passwd', join(gate, 'src/a.test.ts'));
    git(gate, 'add -A src');
    git(gate, 'commit -q -m link');
    await restoreProtectedTests(liveWorkspace(gate), {
      baseBranch: 'main',
      baseSha: base,
      branch: 'auto/x',
    });
    expect(read(gate, 'src/a.test.ts')).toBe("test('a', () => expect(1).toBe(1));\n");
  });

  it('restores paths with spaces, quotes, dollar signs and a leading dash', async () => {
    const odd = [
      "tests/it's got $(touch pwned) spaces.test.ts",
      'tests/-rf.test.ts',
      'tests/a b.test.ts',
    ];
    const { base, gate } = build(Object.fromEntries(odd.map((p) => [p, 'original\n'])));
    for (const p of odd) {
      write(gate, p, 'tampered\n');
    }
    git(gate, 'add -A');
    git(gate, 'commit -q -m tamper');
    const report = await restoreProtectedTests(liveWorkspace(gate), {
      baseBranch: 'main',
      baseSha: base,
      branch: 'auto/x',
    });
    for (const p of odd) {
      expect(read(gate, p), p).toBe('original\n');
    }
    expect(existsSync(join(gate, 'pwned'))).toBe(false);
    expect(report.restored).toEqual(expect.arrayContaining(odd));
  });

  it('reports nothing to do when the change touched no test file', async () => {
    const { base, gate } = build();
    // Reset the branch to a commit that only changes package.json.
    git(gate, 'checkout -q -B only origin/main');
    git(gate, 'fetch -q origin +refs/heads/auto/x:refs/remotes/origin/auto/x');
    git(gate, `checkout -q -B only ${base}`);
    write(gate, 'package.json', '{"changed":true}\n');
    git(gate, 'add -A');
    git(gate, 'commit -q -m only');
    const report = await restoreProtectedTests(liveWorkspace(gate), {
      baseBranch: 'main',
      baseSha: base,
      branch: 'only',
    });
    expect(report.restored).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(read(gate, 'package.json')).toBe('{"changed":true}\n');
  });

  it('restores against the recorded base even when the tip shares no history with it', async () => {
    // The agent chooses its commit's history. A tip rebuilt with no common ancestor (or on an
    // older one) moves no anchor: the comparison is the recorded base's tree against the tip's.
    const { base, gate } = build();
    git(gate, 'checkout -q --orphan unrelated');
    git(gate, 'rm -r -q --cached .');
    rmSync(join(gate, 'src'), { force: true, recursive: true });
    rmSync(join(gate, 'tests'), { force: true, recursive: true });
    write(gate, 'README.md', 'x\n');
    git(gate, 'add README.md');
    git(gate, 'commit -q -m orphan');
    const report = await restoreProtectedTests(liveWorkspace(gate), {
      baseBranch: 'main',
      baseSha: base,
      branch: 'unrelated',
    });
    expect(read(gate, 'src/a.test.ts')).toBe("test('a', () => expect(1).toBe(1));\n");
    expect(read(gate, 'src/b.test.ts')).toBe("test('b', () => expect(2).toBe(2));\n");
    expect(report.base).toBe(base);
  });

  it('fails closed, PROTECTED_TESTS_UNAVAILABLE, when the recorded base is not in the history', async () => {
    const { gate } = build();
    const err = await restoreProtectedTests(liveWorkspace(gate), {
      baseBranch: 'main',
      baseSha: 'c'.repeat(40),
      branch: 'auto/x',
    }).catch((e) => e);
    expect(err.type).toBe(PROTECTED_TESTS_UNAVAILABLE);
    expect(err.nonRetryable).toBe(true);
  });
});
