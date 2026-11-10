import { describe, expect, it } from 'vitest';
import {
  READY_FOR_REVIEW_TRIGGER,
  type ReviewTimeEvaluation,
  reviewTimeOf,
  summarizeReviewTime,
} from './reviewerTime.js';

const at = (iso: string) => new Date(iso);
const HOUR = 3_600_000;
const ev = (over: Partial<ReviewTimeEvaluation> = {}): ReviewTimeEvaluation => ({
  changesRequestedCount: 0,
  createdAt: at('2026-11-01T10:00:00Z'),
  firstHumanReviewAt: null,
  headSha: 'a',
  triggeredBy: 'pull_request.opened',
  ...over,
});

describe('reviewTimeOf', () => {
  it('measures ready-to-review, review-to-merge, rounds and change requests', () => {
    const row = reviewTimeOf({
      evaluations: [
        ev({ changesRequestedCount: 1, firstHumanReviewAt: at('2026-11-01T12:00:00Z') }),
        ev({
          createdAt: at('2026-11-01T14:00:00Z'),
          firstHumanReviewAt: at('2026-11-01T15:00:00Z'),
          headSha: 'b',
        }),
      ],
      firstViewedAt: at('2026-11-01T11:00:00Z'),
      id: 'pr',
      mergedAt: at('2026-11-01T16:00:00Z'),
      openedAt: at('2026-11-01T09:59:00Z'),
    });
    expect(row).toMatchObject({
      changesRequested: 1,
      reviewRounds: 2,
      reviewToMergeMs: 4 * HOUR,
      timeToFirstReviewMs: 2 * HOUR,
      timeToFirstViewMs: HOUR,
    });
  });

  it('starts the clock at the ready-for-review evaluation when there is one', () => {
    const row = reviewTimeOf({
      evaluations: [
        ev({ createdAt: at('2026-11-01T08:00:00Z') }),
        ev({
          createdAt: at('2026-11-02T08:00:00Z'),
          firstHumanReviewAt: at('2026-11-02T09:00:00Z'),
          triggeredBy: READY_FOR_REVIEW_TRIGGER,
        }),
      ],
      firstViewedAt: null,
      id: 'pr',
      mergedAt: null,
      openedAt: at('2026-11-01T08:00:00Z'),
    });
    expect(row.timeToFirstReviewMs).toBe(HOUR);
    expect(row.reviewToMergeMs).toBeNull();
    expect(row.timeToFirstViewMs).toBeNull();
  });

  it('reads a review dated before the clock started as no wait, and invents nothing without data', () => {
    expect(
      reviewTimeOf({
        evaluations: [ev({ firstHumanReviewAt: at('2026-11-01T09:00:00Z') })],
        firstViewedAt: null,
        id: 'a',
        mergedAt: null,
        openedAt: at('2026-11-01T09:00:00Z'),
      }).timeToFirstReviewMs
    ).toBe(0);
    const none = reviewTimeOf({
      evaluations: [],
      firstViewedAt: null,
      id: 'b',
      mergedAt: at('2026-11-02T00:00:00Z'),
      openedAt: at('2026-11-01T09:00:00Z'),
    });
    expect(none).toMatchObject({
      readyAt: null,
      reviewRounds: 0,
      reviewToMergeMs: null,
      timeToFirstReviewMs: null,
    });
  });
});

describe('summarizeReviewTime', () => {
  const row = (hours: number | null, changes = 0) =>
    reviewTimeOf({
      evaluations: [
        ev({
          changesRequestedCount: changes,
          firstHumanReviewAt:
            hours === null ? null : new Date(at('2026-11-01T10:00:00Z').getTime() + hours * HOUR),
        }),
      ],
      firstViewedAt: null,
      id: String(hours),
      mergedAt: null,
      openedAt: at('2026-11-01T10:00:00Z'),
    });

  it('reports percentiles, counts and the change-request rate, and marks a small sample', () => {
    const summary = summarizeReviewTime([row(1), row(2, 1), row(3), row(null)]);
    expect(summary).toMatchObject({
      changeRequestRate: 0.333,
      lowSample: true,
      pullRequests: 4,
      reviewed: 3,
      timeToFirstReview: { count: 3, p50: 2 * HOUR, p90: 3 * HOUR },
      unmeasured: 0,
    });
    expect(summary.reviewRounds).toEqual({ max: 1, mean: 1, median: 1 });
  });

  it('is clear of the low-sample mark at 30 reviewed pull requests', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i + 1));
    expect(summarizeReviewTime(rows).lowSample).toBe(false);
  });

  it('has null figures for an empty cohort', () => {
    expect(summarizeReviewTime([])).toMatchObject({
      changeRequestRate: null,
      reviewed: 0,
      timeToFirstReview: { count: 0, p50: null, p90: null },
    });
  });
});
