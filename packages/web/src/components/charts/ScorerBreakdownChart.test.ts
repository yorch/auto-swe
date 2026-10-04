import { describe, expect, it } from 'vitest';
import { pivotSeries } from './ScorerBreakdownChart';

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
