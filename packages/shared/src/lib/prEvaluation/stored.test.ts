import { describe, expect, it } from 'vitest';
import { briefDetail, MAX_STORED_CRITERIA, MAX_STORED_QUESTIONS } from './stored.js';
import type { BriefEvidence, BriefFinding } from './types.js';

const FINDING: BriefFinding = {
  category: 'secrets',
  description: 'a token is written to the log',
  file: 'src/util.ts',
  line: 3,
  reviewer: 'SECURITY',
  severity: 'WARNING',
  suggestedFix: 'drop the log line',
};

const EVIDENCE: BriefEvidence = {
  ci: 'passed',
  runUrl: 'https://app.example.com/runs/1',
  tests: { failing: 0, passing: 4, total: 4 },
  ui: null,
};

describe('briefDetail', () => {
  it('leaves out every part the evaluation did not have', () => {
    expect(briefDetail(undefined, undefined, undefined)).toEqual({});
    expect(briefDetail(undefined, undefined, [])).toEqual({});
  });

  it('keeps the evidence and the findings as they are', () => {
    expect(briefDetail(undefined, EVIDENCE, [FINDING])).toEqual({
      evidence: EVIDENCE,
      findings: [FINDING],
    });
  });

  it('caps the criteria and questions at the counts the comment shows', () => {
    const detail = briefDetail(
      {
        criteria: Array.from({ length: MAX_STORED_CRITERIA + 5 }, (_, i) => `c${i}`),
        openQuestions: Array.from({ length: MAX_STORED_QUESTIONS + 5 }, (_, i) => `q${i}`),
      },
      undefined,
      undefined
    );
    expect(detail.intent?.criteria).toHaveLength(MAX_STORED_CRITERIA);
    expect(detail.intent?.openQuestions).toHaveLength(MAX_STORED_QUESTIONS);
  });

  it('keeps a settled question only while the question itself is kept', () => {
    const detail = briefDetail(
      {
        criteria: [],
        handled: [
          { note: 'used a bearer token', question: 'which scheme?', resolution: 'implemented' },
          { note: 'dropped', question: 'a question past the cap', resolution: 'left-unchanged' },
        ],
        openQuestions: ['which scheme?'],
      },
      undefined,
      undefined
    );
    expect(detail.intent?.handled).toEqual([
      { note: 'used a bearer token', question: 'which scheme?', resolution: 'implemented' },
    ]);
  });

  it('bounds every free-text field', () => {
    const long = 'x'.repeat(5_000);
    const detail = briefDetail(
      { criteria: [long], openQuestions: [long] },
      { ...EVIDENCE, runUrl: long },
      [{ ...FINDING, description: long, suggestedFix: long }]
    );
    expect(detail.intent?.criteria[0]).toHaveLength(1_000);
    expect(detail.intent?.openQuestions[0]).toHaveLength(1_000);
    expect(detail.evidence?.runUrl).toHaveLength(500);
    expect(detail.findings?.[0]?.description).toHaveLength(1_000);
    expect(detail.findings?.[0]?.suggestedFix).toHaveLength(1_000);
  });

  it('keeps at most as many findings as the selection can produce', () => {
    const detail = briefDetail(
      undefined,
      undefined,
      Array.from({ length: 80 }, (_, i) => ({ ...FINDING, line: i + 1 }))
    );
    expect(detail.findings).toHaveLength(50);
  });
});
