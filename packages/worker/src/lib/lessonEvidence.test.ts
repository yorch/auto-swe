import { describe, expect, it } from 'vitest';
import { buildLessonEvidence, EVIDENCE_FILE_LIMIT, EVIDENCE_TEXT_LIMIT } from './lessonEvidence.js';

const codeResult = (files: number) => ({
  branch: 'auto/T-1',
  diff: 'never forwarded',
  filesChanged: Array.from({ length: files }, (_, i) => ({
    language: 'ts',
    linesAdded: i,
    linesRemoved: 1,
    operation: 'MODIFY',
    path: `src/f${i}.ts`,
  })),
  headSha: 'abc123',
  implementationNotes: 'Added a guard.',
  testResults: { duration_ms: 5, failing: 1, passed: false, passing: 9, stdout: 'x', total: 10 },
});

describe('buildLessonEvidence', () => {
  it('carries the outcome, an earlier rejection and CI failure, and a summary of the change', () => {
    const evidence = buildLessonEvidence({
      ciLogs: 'npm test\nFAIL src/a.test.ts',
      codeResult: codeResult(2),
      outcome: 'MERGED',
      rejectionSummary: 'Missing input validation',
    });
    expect(evidence).toEqual({
      change: {
        filesChanged: [
          { linesAdded: 0, linesRemoved: 1, operation: 'MODIFY', path: 'src/f0.ts' },
          { linesAdded: 1, linesRemoved: 1, operation: 'MODIFY', path: 'src/f1.ts' },
        ],
        filesOmitted: 0,
        headSha: 'abc123',
        implementationNotes: 'Added a guard.',
        tests: { failing: 1, passed: false, passing: 9, total: 10 },
      },
      ciFailure: 'npm test\nFAIL src/a.test.ts',
      outcome: 'MERGED',
      rejectionSummary: 'Missing input validation',
    });
  });

  it('gives a CI failure only its CI log, not a rejection the review already got past', () => {
    // Nothing clears `context.lastRejectionSummary` once the review approves.
    const evidence = buildLessonEvidence({
      ciLogs: 'FAIL src/a.test.ts',
      codeResult: undefined,
      outcome: 'CI_FAILED',
      rejectionSummary: 'Missing input validation',
    });
    expect(evidence).toEqual({ ciFailure: 'FAIL src/a.test.ts', outcome: 'CI_FAILED' });
  });

  it('gives a review failure only its rejection, not an earlier CI log', () => {
    const evidence = buildLessonEvidence({
      ciLogs: 'FAIL src/a.test.ts',
      codeResult: undefined,
      outcome: 'REVIEW_FAILED',
      rejectionSummary: 'Missing input validation',
    });
    expect(evidence).toEqual({
      outcome: 'REVIEW_FAILED',
      rejectionSummary: 'Missing input validation',
    });
  });

  it("reads a fan-out review's per-branch results as the rejection", () => {
    // `consensus-review` keeps the fan-out's results at `context.lastRejectionSummary`.
    const evidence = buildLessonEvidence({
      ciLogs: undefined,
      codeResult: undefined,
      outcome: 'REVIEW_FAILED',
      rejectionSummary: [
        { status: 'SUCCESS' },
        { exports: { 'context.branchRejectionSummary': 'needs tests' }, status: 'FAILED' },
      ],
    });
    expect(evidence.rejectionSummary).toBe('needs tests');
  });

  it('never forwards the diff or test stdout, and bounds the file list', () => {
    const evidence = buildLessonEvidence({
      ciLogs: undefined,
      codeResult: codeResult(EVIDENCE_FILE_LIMIT + 5),
      outcome: 'MERGED',
      rejectionSummary: '',
    });
    expect(JSON.stringify(evidence)).not.toContain('never forwarded');
    expect(evidence.change?.filesChanged).toHaveLength(EVIDENCE_FILE_LIMIT);
    expect(evidence.change?.filesOmitted).toBe(5);
    expect(evidence.rejectionSummary).toBeUndefined();
    expect(evidence.ciFailure).toBeUndefined();
  });

  it('keeps the tail of long CI logs, where the failure is', () => {
    const logs = `${'noise\n'.repeat(2_000)}Error: expected 2 to be 3`;
    const ci = buildLessonEvidence({
      ciLogs: logs,
      codeResult: null,
      outcome: 'CI_FAILED',
      rejectionSummary: null,
    }).ciFailure;
    expect(ci).toMatch(/^\[… \d+ earlier characters\]/);
    expect(ci?.endsWith('Error: expected 2 to be 3')).toBe(true);
    expect(ci?.length).toBeLessThan(EVIDENCE_TEXT_LIMIT + 50);
  });

  it('treats an unknown outcome as COMPLETED', () => {
    expect(
      buildLessonEvidence({
        ciLogs: null,
        codeResult: null,
        outcome: 'BOGUS',
        rejectionSummary: null,
      })
    ).toEqual({ outcome: 'COMPLETED' });
  });
});
