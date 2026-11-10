/**
 * Regression cases for the analyser: the false positives and cheap evasions an adversarial review
 * found in the first version of the guard, each carried out on a diff of the shape `git diff
 * --text --find-renames` produces.
 */
import { describe, expect, it } from 'vitest';
import {
  analyseNameStatus,
  analyseTestIntegrity,
  generatedPathspecs,
  isTestFilePath,
  isTestSupportPath,
  type TestIntegrityKind,
} from './testIntegrity.js';

function modify(path: string, before: string[], after: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -10,${before.length} +10,${after.length} @@`,
    ...before.map((l) => `-${l}`),
    ...after.map((l) => `+${l}`),
    '',
  ].join('\n');
}

function remove(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'deleted file mode 100644',
    'index 1111111..0000000',
    `--- a/${path}`,
    '+++ /dev/null',
    `@@ -1,${lines.length} +0,0 @@`,
    ...lines.map((l) => `-${l}`),
    '',
  ].join('\n');
}

function create(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    '',
  ].join('\n');
}

/** A rename as `--find-renames` reports it, with optional edits. */
function rename(from: string, to: string, before: string[] = [], after: string[] = []): string {
  return [
    `diff --git a/${from} b/${to}`,
    'similarity index 90%',
    `rename from ${from}`,
    `rename to ${to}`,
    ...(before.length + after.length > 0
      ? [
          `--- a/${from}`,
          `+++ b/${to}`,
          `@@ -1,${before.length} +1,${after.length} @@`,
          ...before.map((l) => `-${l}`),
          ...after.map((l) => `+${l}`),
        ]
      : []),
    '',
  ].join('\n');
}

const kinds = (diff: string): TestIntegrityKind[] =>
  analyseTestIntegrity(diff).findings.map((f) => f.kind);

const CASE = ["it('adds', () => {", '  expect(add(1, 2)).toBe(3);', '});'];

describe('whole-diff counts (false positives)', () => {
  it('a renamed test file is an edit, not a deletion', () => {
    expect(kinds(rename('src/old.test.ts', 'src/new.test.ts'))).toEqual([]);
    expect(
      kinds(rename('src/old.test.ts', 'src/new.test.ts', ["it('a', () => {"], ["it('b', () => {"]))
    ).toEqual([]);
  });

  it('a rename out of the test naming convention is a deletion', () => {
    expect(kinds(rename('src/a.test.ts', 'src/a.disabled.ts'))).toEqual(['test_file_deleted']);
  });

  it('a test moved from one file to another nets to zero', () => {
    expect(kinds(remove('src/a.test.ts', CASE) + create('src/b.test.ts', CASE))).toEqual([]);
    expect(kinds(modify('src/a.test.ts', CASE, []) + create('src/b.test.ts', CASE))).toEqual([]);
  });

  it('a deletion is still a deletion when the added tests do not make it up', () => {
    expect(
      kinds(remove('src/a.test.ts', CASE) + create('src/b.test.ts', ["it('x', () => {"]))
    ).toContain('test_file_deleted');
  });

  it('deleting a fixture or helper under test/ is low severity and not a test deletion', () => {
    for (const path of ['test/fixtures/old.json', 'tests/helpers/db.ts', 'spec/openapi.yaml']) {
      const result = analyseTestIntegrity(remove(path, ['{"a":1}']));
      expect(result.findings.map((f) => [f.kind, f.severity])).toEqual([
        ['test_support_deleted', 'low'],
      ]);
      expect(isTestSupportPath(path)).toBe(true);
      expect(isTestFilePath(path)).toBe(false);
    }
  });

  it('removing a duplicated assertion is not a reduction', () => {
    expect(
      kinds(
        modify(
          'src/a.test.ts',
          ['  expect(r).toBe(3);', '  expect(r).toBe(3);'],
          ['  expect(r).toBe(3);']
        )
      )
    ).toEqual([]);
  });

  it('deleting a comment that mentions it( is not a removed test', () => {
    expect(kinds(modify('src/a.test.ts', ['// it (this) was flaky'], []))).toEqual([]);
  });

  it('config exclusions need a test: ruff, javadoc and shade excludes are not test exclusions', () => {
    expect(
      kinds(modify('pyproject.toml', ['[tool.ruff]'], ['[tool.ruff]', 'exclude = ["migrations"]']))
    ).toEqual([]);
    expect(kinds(modify('build.gradle', [], ['javadoc { enabled = false }']))).toEqual([]);
    expect(kinds(modify('pom.xml', [], ['<exclude>META-INF/*.SF</exclude>']))).toEqual([]);
    expect(kinds(modify('pom.xml', [], ['<exclude>**/FlakyTest.java</exclude>']))).toContain(
      'test_config_excludes'
    );
    expect(kinds(modify('pyproject.toml', [], ['norecursedirs = ["slow"]']))).toContain(
      'test_config_excludes'
    );
  });

  it('a coverage threshold moved between files is not lowered', () => {
    expect(
      kinds(
        modify('package.json', ['      "branches": 80,'], []) +
          modify('jest.config.js', [], ['      branches: 80,'])
      )
    ).toEqual([]);
    expect(
      kinds(
        modify('package.json', ['      "branches": 80,'], []) +
          modify('jest.config.js', [], ['      branches: 50,'])
      )
    ).toContain('coverage_threshold_lowered');
  });

  it('skips lockfiles and reads a path with spaces', () => {
    expect(kinds(modify('yarn.lock', ['x'], ['it.skip(', 'a || true']))).toEqual([]);
    expect(kinds(remove('src/my tests/a.test.ts', CASE))).toEqual(['test_file_deleted']);
  });
});

describe('cheap evasions', () => {
  const T = 'src/a.test.ts';
  const binary = [
    'diff --git a/src/a.test.ts b/src/a.test.ts',
    'index 1..2 100644',
    'Binary files a/src/a.test.ts and b/src/a.test.ts differ',
    '',
  ].join('\n');
  it.each([
    [
      'commented-out test',
      modify(
        T,
        CASE,
        CASE.map((l) => `// ${l}`)
      ),
      'test_case_removed',
    ],
    [
      'commented-out assertion',
      modify(T, ['  expect(a).toBe(1);'], ['  // expect(a).toBe(1);']),
      'assertions_reduced',
    ],
    [
      'block-commented assertion',
      modify(T, ['  expect(a).toBe(1);'], ['  /* expect(a).toBe(1); */']),
      'assertions_reduced',
    ],
    [
      'multi-line block comment',
      modify(
        T,
        ['  expect(a).toBe(1);', '  expect(b).toBe(2);'],
        ['/*', '  expect(a).toBe(1);', '  expect(b).toBe(2);', '*/']
      ),
      'assertions_reduced',
    ],
    [
      'python comment',
      modify('tests/test_a.py', ['    assert f() == 3'], ['    # assert f() == 3']),
      'assertions_reduced',
    ],
    [
      'it.skipIf(true)',
      modify(T, ["it('a', () => {"], ["it.skipIf(true)('a', () => {"]),
      'skip_marker_added',
    ],
    [
      'describe.runIf(false)',
      modify(T, ["describe('a', () => {"], ["describe.runIf(false)('a', () => {"]),
      'skip_marker_added',
    ],
    [
      'pytestmark',
      modify(
        'tests/test_a.py',
        ['import pytest'],
        ['import pytest', 'pytestmark = pytest.mark.skip']
      ),
      'skip_marker_added',
    ],
    [
      'raise SkipTest',
      modify(
        'tests/test_a.py',
        ['    assert f() == 3'],
        ['    raise unittest.SkipTest("x")', '    assert f() == 3']
      ),
      'skip_marker_added',
    ],
    [
      'if (false)',
      modify(T, ['  expect(a).toBe(1);'], ['  if (false) expect(a).toBe(1);']),
      'skip_marker_added',
    ],
    [
      'early return',
      modify(T, ["it('a', () => {"], ["it('a', () => { return;"]),
      'skip_marker_added',
    ],
    [
      'swallowed failure',
      modify(T, ['  expect(a).toBe(1);'], ['  try { expect(a).toBe(1); } catch {}']),
      'skip_marker_added',
    ],
    [
      'self comparison',
      modify(T, ['  expect(r).toBe(3);'], ['  expect(r).toBe(r);']),
      'assertion_trivialized',
    ],
    [
      'test script echo',
      modify('package.json', ['    "test": "vitest run",'], ['    "test": "echo ok",']),
      'test_run_bypassed',
    ],
    [
      'test script narrowed',
      modify(
        'package.json',
        ['    "test": "vitest run",'],
        ['    "test": "vitest run src/ok.test.ts",']
      ),
      'test_run_bypassed',
    ],
    [
      'makefile ; true',
      modify('Makefile', ['\tgo test ./...'], ['\tgo test ./... ; true']),
      'test_run_bypassed',
    ],
    [
      'go test -run XXX',
      modify('Makefile', ['\tgo test ./...'], ['\tgo test -run XXX ./...']),
      'test_run_bypassed',
    ],
    [
      'continue-on-error',
      modify(
        '.github/workflows/ci.yml',
        ['      - run: yarn test'],
        ['      - run: yarn test', '        continue-on-error: true']
      ),
      'ci_config_weakened',
    ],
    [
      'allow_failure',
      modify(
        '.gitlab-ci.yml',
        ['  script: yarn test'],
        ['  script: yarn test', '  allow_failure: true']
      ),
      'ci_config_weakened',
    ],
    [
      'test step removed',
      modify('.github/workflows/ci.yml', ['      - run: yarn test'], []),
      'ci_config_weakened',
    ],
    [
      'testMatch narrowed',
      modify(
        'jest.config.js',
        ["  testMatch: ['**/*.test.ts', '**/*.spec.ts'],"],
        ["  testMatch: ['**/*.test.ts'],"]
      ),
      'test_config_narrowed',
    ],
    [
      'include replaced',
      modify(
        'vitest.config.ts',
        ["    include: ['src/**/*.test.ts'],"],
        ["    include: ['src/nothing/**/*.test.ts'],"]
      ),
      'test_config_narrowed',
    ],
    [
      'multi-line exclude',
      modify('vitest.config.ts', [], ['    exclude: [', "      'src/broken.test.ts',", '    ],']),
      'test_config_excludes',
    ],
    [
      'rust inline ignore',
      modify('src/lib.rs', ['    #[test]'], ['    #[test]', '    #[ignore]']),
      'skip_marker_added',
    ],
    [
      'rust inline test removed',
      modify('src/lib.rs', ['    #[test]', '    fn adds() {}'], []),
      'test_case_removed',
    ],
    [
      'snapshot updated',
      modify(
        'src/__snapshots__/a.test.ts.snap',
        ['exports[`a 1`] = `3`;'],
        ['exports[`a 1`] = `4`;']
      ),
      'snapshot_updated',
    ],
    ['attributes file', modify('.gitattributes', [], ['*.test.ts -diff']), 'gitattributes_changed'],
    ['binary test file', binary, 'test_file_unreadable'],
  ])('flags %s', (_name, diff, kind) => {
    expect(kinds(diff)).toContain(kind);
  });

  it('snapshot and fixture signals never carry high severity', () => {
    const result = analyseTestIntegrity(
      modify('src/__snapshots__/a.test.ts.snap', ['x'], ['y']) +
        remove('test/fixtures/a.json', ['{}'])
    );
    expect(result.findings.every((f) => f.severity === 'low')).toBe(true);
  });

  it('a binary stanza on a fixture is not a finding', () => {
    const diff = [
      'diff --git a/test/img.png b/test/img.png',
      'Binary files a/test/img.png and b/test/img.png differ',
      '',
    ].join('\n');
    expect(kinds(diff)).toEqual([]);
  });
});

describe('helpers', () => {
  it('lists generated files as exclude pathspecs', () => {
    expect(generatedPathspecs()).toContain(':(exclude,glob)**/yarn.lock');
  });

  it('reads a name-status list when the diff was too large', () => {
    const findings = analyseNameStatus(
      [
        'M\tsrc/a.ts',
        'D\tsrc/a.test.ts',
        'R100\tsrc/b.test.ts\tsrc/b.old.ts',
        'M\t.gitattributes',
      ].join('\n')
    );
    expect(findings.map((f) => f.kind)).toEqual([
      'test_file_deleted',
      'test_file_deleted',
      'gitattributes_changed',
    ]);
  });
});
