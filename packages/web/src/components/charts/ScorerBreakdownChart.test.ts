import { describe, expect, it } from 'vitest';
import { collapseSeries, pivotSeries } from './ScorerBreakdownChart';

describe('pivotSeries', () => {
  it('puts every series on one row per day, keeping a gap as null', () => {
    const rows = pivotSeries([
      {
        daily: [
          { date: '2026-09-01', mean: 1, n: 2 },
          { date: '2026-09-02', mean: null, n: 0 },
        ],
        label: 'a/x',
      },
      { daily: [{ date: '2026-09-02', mean: 0.5, n: 1 }], label: '(none)' },
    ]);

    expect(rows).toEqual([
      { 'a/x': 1, date: '2026-09-01' },
      { '(none)': 0.5, 'a/x': null, date: '2026-09-02' },
    ]);
  });
});

describe('collapseSeries', () => {
  const series = (label: string, mean: number, n: number) => ({
    daily: [{ date: '2026-09-01', mean, n }],
    label,
  });

  it('leaves a short list alone', () => {
    const input = [series('a', 1, 1)];
    expect(collapseSeries(input, 3)).toBe(input);
  });

  it('folds the smallest series into a signal-weighted Other', () => {
    const out = collapseSeries([series('a', 1, 10), series('b', 0, 1), series('c', 0.5, 3)], 2);
    expect(out.map((s) => s.label)).toEqual(['a', 'Other']);
    expect(out[1].daily).toEqual([{ date: '2026-09-01', mean: 0.375, n: 4 }]);
  });
});
