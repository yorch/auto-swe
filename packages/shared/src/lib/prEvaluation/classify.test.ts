import { describe, expect, it } from 'vitest';
import { classify } from './classify.js';
import { DEFAULT_THRESHOLDS, mergePolicy } from './policy.js';
import type { ChangedFile, EvaluationSignals } from './types.js';

const { effective } = mergePolicy({ ...DEFAULT_THRESHOLDS, sensitivePaths: [] });
const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  additions: 5,
  deletions: 2,
  patch: path.includes('.test.') ? '@@ -1 +1 @@\n+expect(1)' : '@@ -1 +1 @@\n+x',
  path,
  status: 'modified',
  ...over,
});
const signals = (
  files: ChangedFile[],
  over: Partial<EvaluationSignals> = {}
): EvaluationSignals => ({
  draft: false,
  files,
  maxReviewSeverity: 'PASS',
  policyFileChanged: false,
  scannerFindingCount: 0,
  ...over,
});
const clean = [file('src/a.ts'), file('src/a.test.ts')];

describe('classify', () => {
  it('is LOW for a small tested change', () => {
    const result = classify(signals(clean), effective);
    expect(result).toMatchObject({ autoEligible: true, requiredApprovers: 1, riskClass: 'LOW' });
    expect(result.reasons).toEqual([]);
  });

  it('fails closed on an evaluation error', () => {
    const result = classify(signals(clean, { evaluationError: 'timeout' }), effective);
    expect(result).toMatchObject({ autoEligible: false, requiredApprovers: 2, riskClass: 'HIGH' });
    expect(result.reasons[0]?.code).toBe('evaluation-error');
  });

  it('makes any hard exclusion HIGH and never auto', () => {
    const cases: Partial<EvaluationSignals>[] = [
      { files: [...clean, file('db/migrations/1.sql')] },
      { files: [...clean, file('src/old.test.ts', { status: 'removed' })] },
      {
        files: [file('src/a.test.ts', { patch: '@@\n+it.skip("x", () => {})' }), file('src/a.ts')],
      },
      { policyFileChanged: true },
      { scannerFindingCount: 1 },
      { maxReviewSeverity: 'WARNING' },
      { maxReviewSeverity: 'CRITICAL' },
      { maxReviewSeverity: null },
    ];
    for (const over of cases) {
      const result = classify(signals(clean, over), effective);
      expect(result.riskClass, JSON.stringify(over)).toBe('HIGH');
      expect(result.autoEligible).toBe(false);
    }
  });

  it('matches a sensitive path through the previous name of a rename', () => {
    const result = classify(
      signals([file('docs/x.md', { previousPath: 'db/migrations/1.sql', status: 'renamed' })]),
      effective
    );
    expect(result.riskClass).toBe('HIGH');
  });

  it('cannot be relaxed by an empty registry sensitive list', () => {
    const result = classify(signals([file('.github/workflows/ci.yml'), ...clean]), {
      ...effective,
      sensitivePaths: [],
    });
    expect(result.riskClass).toBe('HIGH');
  });

  it('does not flag skip words in non-test files or removed lines', () => {
    expect(
      classify(
        signals([file('src/a.ts', { patch: '@@\n+x.skip(1)' }), ...clean.slice(1)]),
        effective
      ).riskClass
    ).toBe('LOW');
    expect(
      classify(
        signals([
          file('src/a.test.ts', { patch: '@@\n-it.skip("x")\n+it("x")' }),
          file('src/a.ts'),
        ]),
        effective
      ).riskClass
    ).toBe('LOW');
  });

  it('treats a test file with no patch as unverifiable', () => {
    const result = classify(signals([file('src/a.test.ts', { patch: undefined })]), effective);
    expect(result.reasons.map((r) => r.code)).toContain('unverifiable-test-patch');
  });

  it('is HIGH over highLines and for repository high-risk paths', () => {
    const big = classify(
      signals([file('src/a.ts', { additions: 1001, deletions: 0 }), clean[1] as ChangedFile]),
      effective
    );
    expect(big.riskClass).toBe('HIGH');
    expect(big.autoEligible).toBe(false);
    const risky = classify(signals(clean), { ...effective, highRiskPaths: ['src/**'] });
    expect(risky.riskClass).toBe('HIGH');
  });

  it('is STANDARD on size, spread or missing tests', () => {
    const lines = classify(
      signals([file('src/a.ts', { additions: 401, deletions: 0 }), clean[1] as ChangedFile]),
      effective
    );
    expect(lines.riskClass).toBe('STANDARD');
    const many = classify(
      signals([
        ...Array.from({ length: 16 }, (_, i) =>
          file(`src/f${i}.ts`, { additions: 1, deletions: 0 })
        ),
        clean[1] as ChangedFile,
      ]),
      effective
    );
    expect(many.reasons.map((r) => r.code)).toContain('size-files');
    const spread = classify(
      signals([
        ...['a', 'b', 'c', 'd', 'e', 'f'].map((d) => file(`${d}/x.ts`)),
        clean[1] as ChangedFile,
      ]),
      effective
    );
    expect(spread.reasons.map((r) => r.code)).toContain('size-dirs');
    const untested = classify(signals([file('src/a.ts')]), effective);
    expect(untested).toMatchObject({ autoEligible: false, riskClass: 'STANDARD' });
  });

  it('does not ask for tests on a docs-only change', () => {
    expect(classify(signals([file('README.md')]), effective).riskClass).toBe('LOW');
  });

  it('does not count provably skimmable files toward lines', () => {
    const reindented = Array.from({ length: 300 }, (_, n) => `-  x${n}()  \n+  x${n}()`).join('\n');
    const whitespace = file('src/fmt.ts', {
      additions: 300,
      deletions: 300,
      patch: `@@ -1,300 +1,300 @@\n${reindented}`,
    });
    const small = file('src/b.ts', { additions: 100, deletions: 0 });
    const result = classify(signals([whitespace, small, clean[1] as ChangedFile]), effective);
    expect(result.reasons.map((r) => r.code)).not.toContain('size-lines');
    expect(result.riskClass).toBe('LOW');
  });

  it('uses the approver count of the class', () => {
    const custom = { ...effective, highApprovers: 4, lowApprovers: 2, standardApprovers: 3 };
    expect(classify(signals(clean), custom).requiredApprovers).toBe(2);
    expect(classify(signals([file('src/a.ts')]), custom).requiredApprovers).toBe(3);
    expect(classify(signals(clean, { scannerFindingCount: 1 }), custom).requiredApprovers).toBe(4);
  });
});

describe('classify: hardening regressions', () => {
  const codes = (result: ReturnType<typeof classify>): string[] =>
    result.reasons.map((r) => r.code);
  const testFile = (path: string, patch = '@@ -1 +1 @@\n+expect(1)'): ChangedFile =>
    file(path, { patch });

  it('treats a rename from a test path to a non-test path as a removed test (finding 2)', () => {
    const result = classify(
      signals([
        file('src/disabled/a.ts.txt', {
          additions: 0,
          deletions: 0,
          previousPath: 'src/__tests__/a.test.ts',
          similarity: 100,
          status: 'renamed',
        }),
      ]),
      effective
    );
    expect(codes(result)).toContain('removed-test');
    expect(result.riskClass).toBe('HIGH');
  });

  it('detects removed and skipped tests under other conventions (finding 3)', () => {
    for (const path of ['pkg/foo_test.go', 'spec/models/user_spec.rb', 'tests/test_a.py']) {
      const removed = classify(signals([file(path, { status: 'removed' })]), effective);
      expect(codes(removed), path).toContain('removed-test');
    }
    const skipped = classify(
      signals([testFile('pkg/foo_test.go', '@@ -1 +1 @@\n+\tt.Skip("later")')]),
      effective
    );
    expect(codes(skipped)).toContain('test-skip-added');
  });

  it('detects the wider skip markers and does not let ++ bypass the scan (finding 4)', () => {
    const patches = [
      '@@ @@\n+++i; it.skip("x", f)',
      '@@ @@\n++i; it.skip("x", f)',
      '@@ @@\n+it.todo("x")',
      '@@ @@\n+@Disabled("x")',
      '@@ @@\n+  pending("x")',
      '@@ @@\n+@pytest.mark.xfail',
      '@@ @@\n+self.skipTest("x")',
      '@@ @@\n+xtest("x", f)',
      '@@ @@\n+\tt.SkipNow()',
    ];
    for (const patch of patches) {
      const result = classify(signals([testFile('src/a.test.ts', patch)]), effective);
      expect(codes(result), patch).toContain('test-skip-added');
    }
    // a genuine file header before the first hunk is not content
    const header = classify(
      signals([testFile('src/a.test.ts', '--- a/x\n+++ b/it.skip(\n@@ -1 +1 @@\n+ok()')]),
      effective
    );
    expect(codes(header)).not.toContain('test-skip-added');
  });

  it('refuses to scan a test patch over 2 MB (finding 4)', () => {
    const big = `@@ -1 +1 @@\n+${'a'.repeat(2 * 1024 * 1024 + 10)}`;
    const result = classify(signals([testFile('src/a.test.ts', big)]), effective);
    expect(codes(result)).toContain('patch-too-large-to-scan');
    expect(result.riskClass).toBe('HIGH');
  });

  it('is never LOW for an empty PR or one where everything is skimmable (finding 5)', () => {
    for (const files of [
      [],
      [
        file('src/new.ts', {
          additions: 0,
          deletions: 0,
          patch: undefined,
          previousPath: 'src/old.ts',
          similarity: 100,
          status: 'renamed',
        }),
      ],
    ]) {
      const result = classify(signals(files), effective);
      expect(codes(result)).toContain('nothing-to-evaluate');
      expect(result).toMatchObject({ autoEligible: false, riskClass: 'STANDARD' });
    }
  });

  it('checks an exact rename against sensitive globs on both paths (finding 5)', () => {
    const exact = (from: string, to: string): ChangedFile =>
      file(to, {
        additions: 0,
        deletions: 0,
        patch: undefined,
        previousPath: from,
        similarity: 100,
        status: 'renamed',
      });
    expect(classify(signals([exact('src/a.ts', 'src/auth/a.ts')]), effective).riskClass).toBe(
      'HIGH'
    );
    expect(classify(signals([exact('src/auth/a.ts', 'src/a.ts')]), effective).riskClass).toBe(
      'HIGH'
    );
  });

  it('counts a rename into another directory as an ordinary file (finding 5)', () => {
    const moved = file('lib/b/new.ts', {
      additions: 0,
      deletions: 0,
      patch: undefined,
      previousPath: 'lib/a/new.ts',
      similarity: 100,
      status: 'renamed',
    });
    const result = classify(signals([moved, clean[1] as ChangedFile]), effective);
    expect(codes(result)).not.toContain('nothing-to-evaluate');
  });

  it('excludes a non-removed file with no patch, except an exact rename (finding 11)', () => {
    for (const status of ['modified', 'added'] as const) {
      const result = classify(
        signals([file('src/a.ts', { patch: undefined, status }), ...clean]),
        effective
      );
      expect(codes(result), status).toContain('unverifiable-patch');
      expect(result.riskClass).toBe('HIGH');
    }
    const removed = classify(
      signals([file('src/a.ts', { patch: undefined, status: 'removed' })]),
      effective
    );
    expect(codes(removed)).not.toContain('unverifiable-patch');
  });

  it('excludes non-finite or negative counts instead of calling them LOW (finding 12)', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      for (const key of ['additions', 'deletions'] as const) {
        const result = classify(
          signals([file('src/a.ts', { [key]: bad }), clean[1] as ChangedFile]),
          effective
        );
        expect(codes(result), `${key}=${bad}`).toContain('invalid-counts');
        expect(result.riskClass).toBe('HIGH');
        expect(result.autoEligible).toBe(false);
      }
    }
  });

  it('fails closed when the repository policy file was invalid (finding 13)', () => {
    const result = classify(
      signals(clean, { policyErrors: ['sensitivePaths.0: bad glob'] }),
      effective
    );
    expect(codes(result)).toContain('policy-file-invalid');
    expect(result).toMatchObject({ autoEligible: false, riskClass: 'HIGH' });
    expect(codes(classify(signals(clean, { policyErrors: [] }), effective))).not.toContain(
      'policy-file-invalid'
    );
  });
});
