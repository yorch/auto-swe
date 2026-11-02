import { describe, expect, it } from 'vitest';
import { lineInDiff, selectReviewFindings } from './findings.js';
import type { ChangedFile } from './types.js';

const PATCH = [
  '@@ -1,3 +1,4 @@',
  ' keep one',
  '-old two',
  '+new two',
  '+new three',
  ' keep four',
  '@@ -20,2 +21,3 @@',
  ' ctx twenty-one',
  '+added twenty-two',
  ' ctx twenty-three',
].join('\n');

const file = (path: string, patch: string | undefined = PATCH): ChangedFile => ({
  additions: 1,
  deletions: 1,
  patch,
  path,
  status: 'modified',
});
const finding = (over: Record<string, unknown> = {}) => ({
  category: 'logic',
  description: 'the guard is inverted',
  file: 'src/a.ts',
  line: 2,
  suggestedFix: 'flip it',
  ...over,
});
const verdict = (severity: string, findings: unknown[], reviewer = 'DOMAIN_LOGIC') => ({
  approved: severity === 'PASS',
  findings,
  reviewer,
  severity,
});

describe('lineInDiff', () => {
  it('finds added and context lines on the new side, in every hunk', () => {
    for (const line of [1, 2, 3, 4, 21, 22, 23]) {
      expect(lineInDiff(PATCH, line), String(line)).toBe(true);
    }
  });

  it('refuses a removed line, a line between hunks and one past the end', () => {
    expect(lineInDiff(PATCH, 5)).toBe(false);
    expect(lineInDiff(PATCH, 20)).toBe(false);
    expect(lineInDiff(PATCH, 24)).toBe(false);
  });

  it('refuses a missing patch and a line that is not a positive integer', () => {
    expect(lineInDiff(undefined, 1)).toBe(false);
    expect(lineInDiff('', 1)).toBe(false);
    expect(lineInDiff(PATCH, 0)).toBe(false);
    expect(lineInDiff(PATCH, 1.5)).toBe(false);
    expect(lineInDiff(PATCH, Number.NaN)).toBe(false);
  });

  it('skips the no-newline marker and a trailing newline', () => {
    const patch = '@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n';
    expect(lineInDiff(patch, 1)).toBe(true);
    expect(lineInDiff(patch, 2)).toBe(false);
  });
});

describe('selectReviewFindings', () => {
  const files = [file('src/a.ts'), file('src/b.ts'), file('src/c.ts')];

  it('keeps warning and critical findings and nothing from a passing verdict', () => {
    const out = selectReviewFindings(
      [
        verdict('PASS', [finding({ description: 'fine' })]),
        verdict('INFO', [finding({ description: 'fyi' })]),
        verdict('WARNING', [finding()]),
      ],
      files,
      'passed'
    );
    expect(out).toEqual([
      {
        category: 'logic',
        description: 'the guard is inverted',
        file: 'src/a.ts',
        line: 2,
        reviewer: 'DOMAIN_LOGIC',
        severity: 'WARNING',
        suggestedFix: 'flip it',
      },
    ]);
  });

  it('ranks critical first, then by reading position, then by line', () => {
    const out = selectReviewFindings(
      [
        verdict('WARNING', [
          finding({ file: 'src/c.ts', line: 1 }),
          finding({ category: 'b', file: 'src/a.ts', line: 3 }),
          finding({ category: 'a', file: 'src/a.ts', line: 1 }),
        ]),
        verdict('CRITICAL', [finding({ category: 'sec', file: 'src/c.ts', line: 2 })], 'SECURITY'),
      ],
      files,
      null
    );
    expect(out.map((f) => `${f.severity}:${f.file}:${f.line}`)).toEqual([
      'CRITICAL:src/c.ts:2',
      'WARNING:src/a.ts:1',
      'WARNING:src/a.ts:3',
      'WARNING:src/c.ts:1',
    ]);
  });

  it('drops a crash, a file outside the change, an empty description and a repeat', () => {
    const out = selectReviewFindings(
      [
        verdict('CRITICAL', [
          finding({ category: 'REVIEWER_CRASH', file: '' }),
          finding({ file: 'src/not-changed.ts' }),
          finding({ description: '   ' }),
          finding(),
          finding(),
        ]),
      ],
      files,
      null
    );
    expect(out).toHaveLength(1);
  });

  it('leaves the line off when it is not in the patch, so the finding is unanchored', () => {
    const [kept] = selectReviewFindings([verdict('WARNING', [finding({ line: 99 })])], files, null);
    expect(kept?.line).toBeNull();
    const [noPatch] = selectReviewFindings(
      [verdict('WARNING', [finding()])],
      [{ ...file('src/a.ts'), patch: undefined }],
      null
    );
    expect(noPatch?.line).toBeNull();
  });

  it('drops style, format and type findings only when CI failed', () => {
    const findings = [
      finding({ category: 'Lint' }),
      finding({ category: 'formatting' }),
      finding({ category: 'type-check' }),
      finding({ category: 'security' }),
      finding({ category: 'logic', description: 'also a style problem' }),
    ];
    const failed = selectReviewFindings([verdict('WARNING', findings)], files, 'failed');
    expect(failed.map((f) => f.category).sort()).toEqual(['logic', 'security']);
    const passed = selectReviewFindings([verdict('WARNING', findings)], files, 'passed');
    expect(passed).toHaveLength(5);
  });

  it('survives verdicts of any shape', () => {
    for (const verdicts of [undefined, null, 'x', 3, {}, [null], [{}], [{ severity: 'WARNING' }]]) {
      expect(selectReviewFindings(verdicts, files, null)).toEqual([]);
    }
    expect(
      selectReviewFindings(
        [verdict('WARNING', [null, 'x', { file: 3 }, finding({ line: 'two' })])],
        files,
        null
      )
    ).toHaveLength(1);
  });
});
