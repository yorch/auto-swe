import { describe, expect, it } from 'vitest';
import {
  analyseTestIntegrity,
  isTestFilePath,
  MAX_ANALYSED_DIFF_CHARS,
  MAX_FINDINGS,
  parseUnifiedDiff,
  summariseTestIntegrity,
  type TestIntegrityKind,
} from './testIntegrity.js';

/** A modification of one file: `before` lines replaced by `after` lines in a single hunk. */
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

function kinds(diff: string): TestIntegrityKind[] {
  return analyseTestIntegrity(diff).findings.map((f) => f.kind);
}

describe('isTestFilePath', () => {
  it.each([
    'src/a.test.ts',
    'src/a.spec.tsx',
    'src/__tests__/a.ts',
    'tests/test_a.py',
    'pkg/a_test.go',
    'spec/models/user_spec.rb',
    'src/test/java/com/x/FooTest.java',
    'app/Tests/FooTests.cs',
    'features/login.feature',
  ])('treats %s as a test file', (path) => {
    expect(isTestFilePath(path)).toBe(true);
  });

  it.each(['src/a.ts', 'src/latest.ts', 'lib/contest.py', 'docs/testing.md'])(
    'does not treat %s as a test file',
    (path) => {
      expect(isTestFilePath(path)).toBe(false);
    }
  );
});

describe('parseUnifiedDiff', () => {
  it('reads removed lines and the new-file line number of added lines', () => {
    const [file] = parseUnifiedDiff(modify('a.test.ts', ['old'], ['new', 'newer']));
    expect(file?.path).toBe('a.test.ts');
    expect(file?.removed).toEqual(['old']);
    expect(file?.added.map(({ line, text }) => ({ line, text }))).toEqual([
      { line: 10, text: 'new' },
      { line: 11, text: 'newer' },
    ]);
  });

  it('does not read a removed line starting with "--" as a header', () => {
    const [file] = parseUnifiedDiff(modify('a.sql', ['-- comment'], ['select 1']));
    expect(file?.removed).toEqual(['-- comment']);
  });

  it('marks a deleted file', () => {
    expect(parseUnifiedDiff(remove('a.test.ts', ['x']))[0]?.deleted).toBe(true);
  });
});

describe('analyseTestIntegrity: clean changes', () => {
  it('finds nothing in a source fix', () => {
    expect(kinds(modify('src/a.ts', ['return a - b;'], ['return a + b;']))).toEqual([]);
  });

  it('finds nothing when a test is fixed in place', () => {
    expect(
      kinds(
        modify(
          'src/a.test.ts',
          ["  it('adds', () => {", '    expect(add(1, 2)).toBe(4);'],
          ["  it('adds', () => {", '    expect(add(1, 2)).toBe(3);']
        )
      )
    ).toEqual([]);
  });

  it('finds nothing when a test is added', () => {
    expect(
      kinds(modify('src/a.test.ts', [], ["it('new', () => {", '  expect(f()).toBe(1);', '});']))
    ).toEqual([]);
  });

  it('finds nothing for an empty diff', () => {
    expect(analyseTestIntegrity('')).toEqual({
      findings: [],
      truncatedDiff: false,
      truncatedFindings: false,
    });
  });
});

describe('analyseTestIntegrity: deleted tests', () => {
  it('flags a deleted test file', () => {
    const result = analyseTestIntegrity(
      remove('src/a.test.ts', ["it('a', () => {", '  expect(1).toBe(1);', '});'])
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ file: 'src/a.test.ts', kind: 'test_file_deleted' });
  });

  it('does not flag a deleted non-test file', () => {
    expect(kinds(remove('src/a.ts', ['export const a = 1;']))).toEqual([]);
  });

  it.each([
    ['jest', 'src/a.test.ts', ["it('a', () => {", '});']],
    ['pytest', 'tests/test_a.py', ['def test_a():', '    assert f() == 1']],
    ['go', 'a_test.go', ['func TestA(t *testing.T) {', '}']],
    ['junit', 'src/test/FooTest.java', ['    @Test', '    void a() {}']],
    ['rspec', 'spec/a_spec.rb', ["  it 'works' do", '  end']],
    ['rust', 'src/a_test.rs', ['#[test]', 'fn a() {}']],
  ])('flags a removed %s test case', (_name, path, removed) => {
    expect(kinds(modify(path, removed, []))).toContain('test_case_removed');
  });

  it('does not flag a renamed test (one removed, one added)', () => {
    expect(
      kinds(
        modify(
          'src/a.test.ts',
          ["it('old name', () => {", '  expect(f()).toBe(1);'],
          ["it('new name', () => {", '  expect(f()).toBe(1);']
        )
      )
    ).toEqual([]);
  });
});

describe('analyseTestIntegrity: skip markers', () => {
  it.each([
    ['it.skip', 'src/a.test.ts', "it.skip('a', () => {"],
    ['xit', 'src/a.test.ts', "xit('a', () => {"],
    ['describe.skip', 'src/a.test.ts', "describe.skip('a', () => {"],
    ['it.only', 'src/a.test.ts', "it.only('a', () => {"],
    ['pytest skip', 'tests/test_a.py', '@pytest.mark.skip(reason="flaky")'],
    ['pytest xfail', 'tests/test_a.py', '@pytest.mark.xfail'],
    ['pytest.skip()', 'tests/test_a.py', '    pytest.skip("later")'],
    ['unittest skip', 'tests/test_a.py', '@unittest.skip("later")'],
    ['junit ignore', 'src/test/FooTest.java', '    @Ignore'],
    ['junit5 disabled', 'src/test/FooTest.java', '    @Disabled("later")'],
    ['go skip', 'a_test.go', '\tt.Skip("later")'],
    ['rust ignore', 'src/a_test.rs', '#[ignore]'],
    ['rspec skip', 'spec/a_spec.rb', "  skip 'later'"],
  ])('flags %s added to an existing test', (_name, path, line) => {
    expect(kinds(modify(path, ['// context'], ['// context', line]))).toContain(
      'skip_marker_added'
    );
  });

  it('reports the line of the marker', () => {
    const result = analyseTestIntegrity(
      modify('src/a.test.ts', ["it('a', () => {"], ["it.skip('a', () => {"])
    );
    expect(result.findings.find((f) => f.kind === 'skip_marker_added')?.line).toBe(10);
  });

  it('does not flag a skip marker that was already there', () => {
    expect(
      kinds(modify('src/a.test.ts', ["it.skip('a', () => {"], ["it.skip('a renamed', () => {"]))
    ).toEqual([]);
  });

  it('does not flag a skip marker removed (a test re-enabled)', () => {
    expect(kinds(modify('src/a.test.ts', ["it.skip('a', () => {"], ["it('a', () => {"]))).toEqual(
      []
    );
  });

  it('ignores skip text in a source file', () => {
    expect(
      kinds(modify('src/a.ts', ['const a = 1;'], ['// @Ignore the previous', 'x.skip()']))
    ).toEqual([]);
  });
});

describe('analyseTestIntegrity: assertions', () => {
  it('flags a net drop in assertions', () => {
    const result = analyseTestIntegrity(
      modify(
        'src/a.test.ts',
        ['  expect(a).toBe(1);', '  expect(b).toBe(2);', '  expect(c).toBe(3);'],
        ['  expect(a).toBe(1);']
      )
    );
    expect(result.findings.map((f) => f.kind)).toEqual(['assertions_reduced']);
    expect(result.findings[0]?.detail).toContain('net 2 fewer');
  });

  it('flags removed python and java assertions', () => {
    expect(
      kinds(modify('tests/test_a.py', ['    assert f() == 1', '    assert g() == 2'], ['    pass']))
    ).toContain('assertions_reduced');
    expect(
      kinds(modify('src/test/FooTest.java', ['    assertEquals(1, f());'], ['    f();']))
    ).toContain('assertions_reduced');
  });

  it('does not flag assertions that are rewritten one for one', () => {
    expect(
      kinds(modify('src/a.test.ts', ['  expect(a).toBe(1);'], ['  expect(a).toBe(2);']))
    ).toEqual([]);
  });

  it('does not flag assertions removed from a non-test file', () => {
    expect(kinds(modify('src/a.ts', ['assert(x);'], ['// removed']))).toEqual([]);
  });

  it.each([
    ['expect(true).toBe(true)', 'src/a.test.ts'],
    ['expect(1).toBe(1)', 'src/a.test.ts'],
    ['assert True', 'tests/test_a.py'],
    ['assert 1 == 1', 'tests/test_a.py'],
    ['self.assertTrue(True)', 'tests/test_a.py'],
    ['assertEquals(1, 1);', 'src/test/FooTest.java'],
    ['assert.ok(true)', 'src/a.test.ts'],
  ])('flags %s as a trivial assertion', (line, path) => {
    expect(kinds(modify(path, ['  expect(f()).toBe(3);'], [`  ${line}`]))).toContain(
      'assertion_trivialized'
    );
  });

  it('does not flag a real assertion as trivial', () => {
    expect(
      kinds(modify('src/a.test.ts', ['  expect(f()).toBe(3);'], ['  expect(f()).toBe(4);']))
    ).toEqual([]);
  });

  it('flags a specific assertion replaced by a weak one', () => {
    const result = analyseTestIntegrity(
      modify('src/a.test.ts', ['  expect(f()).toBe(3);'], ['  expect(f()).toBeDefined();'])
    );
    expect(result.findings.map((f) => f.kind)).toEqual(['assertion_loosened']);
  });

  it('does not flag a weak assertion added alongside the strong one', () => {
    expect(
      kinds(
        modify(
          'src/a.test.ts',
          ['  expect(f()).toBe(3);'],
          ['  expect(f()).toBe(3);', '  expect(g()).toBeDefined();']
        )
      )
    ).toEqual([]);
  });
});

describe('analyseTestIntegrity: test configuration', () => {
  it('flags a test path ignored in jest config', () => {
    const result = analyseTestIntegrity(
      modify(
        'jest.config.js',
        ['  testMatch: ["**/*.test.js"],'],
        ['  testMatch: ["**/*.test.js"],', '  testPathIgnorePatterns: ["/flaky/"],']
      )
    );
    expect(result.findings.map((f) => f.kind)).toEqual(['test_config_excludes']);
  });

  it('flags an exclude added to the vitest config', () => {
    expect(
      kinds(
        modify(
          'vitest.config.ts',
          ['  include: ["**/*.test.ts"],'],
          ['  exclude: ["src/slow/**"],']
        )
      )
    ).toContain('test_config_excludes');
  });

  it('flags pytest --ignore and --deselect in addopts', () => {
    expect(
      kinds(
        modify('pytest.ini', ['addopts = -q'], ['addopts = -q --ignore=tests/slow --deselect a'])
      )
    ).toContain('test_config_excludes');
  });

  it('ignores an exclude in a file that is not test config', () => {
    expect(kinds(modify('src/build.ts', [], ['exclude: ["x"]']))).toEqual([]);
  });

  it('flags a lowered coverage threshold', () => {
    const result = analyseTestIntegrity(
      modify(
        'jest.config.js',
        ['  coverageThreshold: { global: { branches: 80, lines: 90 } },'],
        ['  coverageThreshold: { global: { branches: 50, lines: 90 } },']
      )
    );
    expect(result.findings.map((f) => f.kind)).toEqual(['coverage_threshold_lowered']);
    expect(result.findings[0]?.detail).toContain('branches 80 -> 50');
  });

  it('flags a removed coverage threshold and a lowered fail_under', () => {
    expect(kinds(modify('vitest.config.ts', ['  lines: 80,'], ['  // none']))).toContain(
      'coverage_threshold_lowered'
    );
    expect(kinds(modify('.coveragerc', ['fail_under = 90'], ['fail_under = 10']))).toContain(
      'coverage_threshold_lowered'
    );
  });

  it('does not flag a raised coverage threshold', () => {
    expect(kinds(modify('.coveragerc', ['fail_under = 80'], ['fail_under = 90']))).toEqual([]);
  });

  it('flags a test command that cannot fail', () => {
    expect(
      kinds(modify('package.json', ['    "test": "jest"'], ['    "test": "jest || true"']))
    ).toContain('test_run_bypassed');
    expect(
      kinds(
        modify('package.json', ['    "test": "jest"'], ['    "test": "jest --passWithNoTests"'])
      )
    ).toContain('test_run_bypassed');
  });
});

describe('analyseTestIntegrity: limits', () => {
  it('reports every finding of a multi-file diff, in file order', () => {
    const diff =
      remove('a.test.ts', ["it('a', () => {"]) +
      modify('b.test.ts', ["it('b', () => {"], ["it.skip('b', () => {"]);
    expect(analyseTestIntegrity(diff).findings.map((f) => [f.file, f.kind])).toEqual([
      ['a.test.ts', 'test_file_deleted'],
      ['b.test.ts', 'skip_marker_added'],
    ]);
  });

  it('caps the findings list and says so', () => {
    const diff = Array.from({ length: MAX_FINDINGS + 5 }, (_, i) =>
      remove(`t${i}.test.ts`, ["it('a', () => {"])
    ).join('');
    const result = analyseTestIntegrity(diff);
    expect(result.findings).toHaveLength(MAX_FINDINGS);
    expect(result.truncatedFindings).toBe(true);
  });

  it('reads only the head of an oversized diff and says so', () => {
    const big = `${remove('a.test.ts', ["it('a', () => {"])}${'x'.repeat(MAX_ANALYSED_DIFF_CHARS)}`;
    const result = analyseTestIntegrity(big);
    expect(result.truncatedDiff).toBe(true);
    expect(result.findings[0]?.kind).toBe('test_file_deleted');
  });

  it('known miss: assertions moved into a helper are seen only as a drop in the test file', () => {
    // Documented limit: the helper gains the checks, but is not a test file, so the analyser
    // reports the drop and cannot tell the checks still exist.
    const diff =
      modify('src/a.test.ts', ['  expect(a).toBe(1);'], ['  check(a);']) +
      modify('src/helpers.ts', [], ['export const check = (a) => {};']);
    expect(kinds(diff)).toEqual(['assertions_reduced']);
  });

  it('a consolidation into a parameterised test reads as a reduction at low severity', () => {
    const result = analyseTestIntegrity(
      modify(
        'src/a.test.ts',
        [
          "it('a', () => {",
          '  expect(f(1)).toBe(1);',
          '});',
          "it('b', () => {",
          '  expect(f(2)).toBe(2);',
          '});',
        ],
        ["it.each([1, 2])('f %i', (n) => {", '  expect(f(n)).toBe(n);', '});']
      )
    );
    expect(result.findings.map((f) => f.severity)).toEqual(['low', 'low']);
    expect(result.findings.map((f) => f.kind)).toContain('assertions_reduced');
  });

  it('summarises findings one per line', () => {
    const { findings } = analyseTestIntegrity(
      modify('src/a.test.ts', ["it('a', () => {"], ["it.skip('a', () => {"])
    );
    expect(summariseTestIntegrity(findings)).toBe(
      'skip_marker_added src/a.test.ts:10 — 1 more skip, focus, disabling or expected-failure marker(s) added than removed'
    );
  });
});
