import { describe, expect, it } from 'vitest';
import { type PullRequestOutcomeRow, summarizePullRequestOutcomes } from './pullRequestOutcomes.js';

const T0 = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;

function pr(over: Partial<PullRequestOutcomeRow> & { hours?: number } = {}): PullRequestOutcomeRow {
  const { hours, ...rest } = over;
  return {
    ciStatus: 'PASSED',
    isDraft: false,
    mergedAt: hours === undefined ? null : new Date(T0 + hours * HOUR),
    openedAt: new Date(T0),
    status: 'OPEN',
    ...rest,
  };
}

describe('summarizePullRequestOutcomes', () => {
  it('has a null merge rate and null percentiles for an empty cohort', () => {
    const s = summarizePullRequestOutcomes([]);
    expect(s.opened).toBe(0);
    expect(s.mergeRate).toBeNull();
    expect(s.timeToMergeMs).toEqual({ count: 0, p50: null, p95: null });
    expect(s.ciStatusCounts).toEqual({});
  });

  it('has a null merge rate when every PR is still open', () => {
    const s = summarizePullRequestOutcomes([pr(), pr({ ciStatus: 'PENDING', isDraft: true })]);
    expect(s).toMatchObject({
      closedUnmerged: 0,
      draftCount: 1,
      merged: 0,
      mergeRate: null,
      open: 2,
    });
    expect(s.ciStatusCounts).toEqual({ PASSED: 1, PENDING: 1 });
  });

  it('computes the merge rate over resolved PRs only', () => {
    const s = summarizePullRequestOutcomes([
      pr({ hours: 2, status: 'MERGED' }),
      pr({ hours: 4, status: 'MERGED' }),
      pr({ status: 'CLOSED' }),
      pr(),
    ]);
    expect(s).toMatchObject({ closedUnmerged: 1, merged: 2, open: 1, opened: 4 });
    expect(s.mergeRate).toBeCloseTo(2 / 3);
  });

  it('takes nearest-rank percentiles of the time to merge', () => {
    const rows = Array.from({ length: 20 }, (_, i) => pr({ hours: i + 1, status: 'MERGED' }));
    const s = summarizePullRequestOutcomes(rows);
    expect(s.timeToMergeMs).toEqual({ count: 20, p50: 10 * HOUR, p95: 19 * HOUR });
  });

  it('ignores negative and missing merge durations', () => {
    const s = summarizePullRequestOutcomes([
      pr({ hours: -3, status: 'MERGED' }),
      pr({ status: 'MERGED' }),
      pr({ hours: 5, status: 'MERGED' }),
    ]);
    expect(s.merged).toBe(3);
    expect(s.timeToMergeMs).toEqual({ count: 1, p50: 5 * HOUR, p95: 5 * HOUR });
  });
});
