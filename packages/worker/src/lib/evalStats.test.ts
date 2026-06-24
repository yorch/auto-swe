import { describe, expect, it } from 'vitest';
import {
  clusteredDelta,
  deltaByTag,
  type PairedOutcome,
  pairedProportionDelta,
  regressionVerdict,
} from './evalStats.js';

/** Build n paired outcomes from arrays of 0/1. */
function pairs(baseline: number[], candidate: number[], tags?: string[][]): PairedOutcome[] {
  return baseline.map((b, i) => ({
    baseline: b as 0 | 1,
    candidate: candidate[i] as 0 | 1,
    caseId: `c${i}`,
    tags: tags?.[i],
  }));
}

describe('pairedProportionDelta', () => {
  it('returns zeros for an empty set', () => {
    expect(pairedProportionDelta([])).toMatchObject({ delta: 0, n: 0, se: 0 });
  });

  it('computes the pass-rate delta and a non-zero SE for a mixed result', () => {
    // baseline 8/10 pass, candidate 6/10 pass → delta -0.2
    const b = [1, 1, 1, 1, 1, 1, 1, 1, 0, 0];
    const c = [1, 1, 1, 1, 1, 1, 0, 0, 0, 0];
    const d = pairedProportionDelta(pairs(b, c));
    expect(d.n).toBe(10);
    expect(d.baselineRate).toBeCloseTo(0.8, 6);
    expect(d.candidateRate).toBeCloseTo(0.6, 6);
    expect(d.delta).toBeCloseTo(-0.2, 6);
    expect(d.se).toBeGreaterThan(0);
    expect(d.ci95[0]).toBeLessThan(d.delta);
    expect(d.ci95[1]).toBeGreaterThan(d.delta);
  });

  it('has zero SE when every pair moves identically (no variance in differences)', () => {
    // every case regresses by exactly 1 → delta -1, no variance
    const d = pairedProportionDelta(pairs([1, 1, 1], [0, 0, 0]));
    expect(d.delta).toBeCloseTo(-1, 6);
    expect(d.se).toBeCloseTo(0, 6);
  });
});

describe('regressionVerdict', () => {
  it('does NOT flag a small delta whose CI straddles zero (underpowered)', () => {
    // 1pp difference on 20 cases — inside the error bars
    const b = Array(20).fill(1);
    const c = [...Array(19).fill(1), 0];
    const v = regressionVerdict(pairs(b, c));
    expect(v.regression).toBe(false);
  });

  it('flags a large, consistent regression (CI entirely below 0)', () => {
    // every one of 12 cases regresses → CI is a point at -1, below 0
    const v = regressionVerdict(pairs(Array(12).fill(1), Array(12).fill(0)));
    expect(v.regression).toBe(true);
    expect(v.summary).toContain('REGRESSION');
  });

  it('does not flag an improvement', () => {
    const v = regressionVerdict(pairs(Array(12).fill(0), Array(12).fill(1)));
    expect(v.regression).toBe(false);
  });
});

describe('deltaByTag', () => {
  it('reports a separate delta per tag', () => {
    const out = deltaByTag(
      pairs([1, 1, 1, 1], [0, 0, 1, 1], [['repo:a'], ['repo:a'], ['repo:b'], ['repo:b']])
    );
    expect(out['repo:a'].delta).toBeCloseTo(-1, 6);
    expect(out['repo:b'].delta).toBeCloseTo(0, 6);
  });
});

describe('clusteredDelta', () => {
  it('keeps the overall point estimate but sets N to the cluster count', () => {
    const p = pairs([1, 1, 1, 1], [0, 0, 0, 0], [['repo:a'], ['repo:a'], ['repo:b'], ['repo:b']]);
    const d = clusteredDelta(p, (x) => x.tags?.[0] ?? 'none');
    expect(d.delta).toBeCloseTo(-1, 6);
    expect(d.n).toBe(2); // two clusters, not four cases
  });
});
