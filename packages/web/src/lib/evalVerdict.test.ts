import { describe, expect, it } from 'vitest';
import { formatPoints, type PairedDelta, significance, verdictSentence } from './evalVerdict';

const d = (delta: number, lo: number, hi: number): PairedDelta => ({
  baselineRate: 0.8,
  candidateRate: 0.8 + delta,
  ci95: [lo, hi],
  delta,
  n: 10,
  se: 0.05,
});

describe('eval verdict', () => {
  it('says how far the candidate moved and whether that is significant', () => {
    expect(verdictSentence(d(-0.042, -0.08, -0.01))).toEqual({
      text: 'Candidate is 4.2 points worse than the baseline, and the difference is significant.',
      tone: 'error',
    });
    expect(verdictSentence(d(0.05, 0.01, 0.09)).tone).toBe('success');
    expect(verdictSentence(d(-0.1, -0.2, 0)).text).toMatch(/within the margin of error/);
    expect(verdictSentence(d(0, -0.1, 0.1)).text).toBe(
      'Candidate scored the same as the baseline.'
    );
  });

  it('classifies significance from the interval and formats signed points', () => {
    expect(significance(d(-0.1, -0.2, -0.01))).toBe('worse');
    expect(significance(d(0.1, 0.01, 0.2))).toBe('better');
    expect(significance(d(0.1, -0.01, 0.2))).toBe('none');
    expect(formatPoints(-0.2)).toBe('−20.0 pts');
    expect(formatPoints(0.042)).toBe('+4.2 pts');
  });
});
