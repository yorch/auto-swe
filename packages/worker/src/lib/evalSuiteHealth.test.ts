import { describe, expect, it } from 'vitest';
import {
  assessSuiteHealth,
  judgeAllowedCaseIds,
  selectAnchorSubset,
  withinCostCeiling,
} from './evalSuiteHealth.js';

describe('assessSuiteHealth (fail closed)', () => {
  it('is healthy within all thresholds', () => {
    const v = assessSuiteHealth({ flakeRate: 0.05, judgeKappa: 0.6, staleRate: 0.02 });
    expect(v.healthy).toBe(true);
    expect(v.failures).toEqual([]);
  });

  it('fails on a high flake rate', () => {
    const v = assessSuiteHealth({ flakeRate: 0.2, judgeKappa: 0.6, staleRate: 0 });
    expect(v.healthy).toBe(false);
    expect(v.failures[0]).toContain('flake rate');
  });

  it('fails on low judge κ', () => {
    const v = assessSuiteHealth({ flakeRate: 0, judgeKappa: 0.2, staleRate: 0 });
    expect(v.healthy).toBe(false);
    expect(v.failures[0]).toContain('κ');
  });

  it('skips the κ check for execution-only suites (NaN κ)', () => {
    const v = assessSuiteHealth({ flakeRate: 0, judgeKappa: Number.NaN, staleRate: 0 });
    expect(v.healthy).toBe(true);
  });

  it('reports multiple failures at once', () => {
    const v = assessSuiteHealth({ flakeRate: 0.5, judgeKappa: 0.1, staleRate: 0.5 });
    expect(v.failures).toHaveLength(3);
  });
});

describe('withinCostCeiling', () => {
  it('is unbounded when the ceiling is null', () => {
    expect(withinCostCeiling(1e9, null)).toBe(true);
  });
  it('trips when spend exceeds the ceiling', () => {
    expect(withinCostCeiling(11, 10)).toBe(false);
    expect(withinCostCeiling(10, 10)).toBe(true);
  });
});

describe('selectAnchorSubset', () => {
  it('returns everything when k >= n', () => {
    expect(selectAnchorSubset([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });
  it('returns nothing for k <= 0', () => {
    expect(selectAnchorSubset([1, 2, 3], 0)).toEqual([]);
  });
  it('spreads the subset evenly and is deterministic', () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const a = selectAnchorSubset(items, 5);
    const b = selectAnchorSubset(items, 5);
    expect(a).toEqual(b); // deterministic, no RNG
    expect(a).toHaveLength(5);
    expect(a[0]).toBe(0);
    expect(new Set(a).size).toBe(5); // no duplicates
  });
});

describe('judgeAllowedCaseIds (tiered scoring)', () => {
  it('limits the judge to the anchor subset', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const allowed = judgeAllowedCaseIds(ids, 2);
    expect(allowed.size).toBe(2);
    for (const id of allowed) {
      expect(ids).toContain(id);
    }
  });
});
