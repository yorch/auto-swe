import type { EvalScorerTrend } from '@auto-swe/shared/types/api';
import { describe, expect, it } from 'vitest';
import { latestMean, scorerChange, worstMovingScorer } from './evalTrend';

const trend = (scorer: string, means: (number | null)[], n = 5): EvalScorerTrend => ({
  daily: means.map((mean, i) => ({ date: `2026-09-0${i + 1}`, mean, n: mean === null ? 0 : 1 })),
  mean: 0.5,
  n,
  scorer,
});

describe('eval trends', () => {
  it('measures movement from the first to the latest day with signal', () => {
    expect(scorerChange(trend('a', [null, 0.9, null, 0.6]))).toBeCloseTo(-0.3);
    expect(scorerChange(trend('a', [0.9]))).toBeNull();
    expect(latestMean(trend('a', [0.4, null]))).toBe(0.4);
  });

  it('defaults to the scorer that fell furthest, else the busiest', () => {
    expect(
      worstMovingScorer([
        trend('up', [0.2, 0.9]),
        trend('down', [0.9, 0.7]),
        trend('dive', [0.8, 0.2]),
      ])
    ).toBe('dive');
    expect(worstMovingScorer([trend('a', [0.2, 0.9], 3), trend('b', [0.5, 0.5], 9)])).toBe('b');
    expect(worstMovingScorer([])).toBeNull();
  });
});
