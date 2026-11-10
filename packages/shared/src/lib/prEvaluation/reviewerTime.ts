import { MIN_SAMPLES_FOR_SIGNIFICANCE, percentile } from '../../workflow/analytics.js';

/**
 * Reviewer time, measured only from timestamps the platform stores:
 *
 * - **Ready** is the creation time of the pull request's `pull_request.ready_for_review`
 *   evaluation when it has one, else of its earliest evaluation (the one its opening started).
 *   The host's own "marked ready" instant is not stored, and an evaluation can lag it.
 * - **First human review** is the earliest `firstHumanReviewAt` over the pull request's
 *   evaluations: the platform's receipt of the first review by a person other than the author, a
 *   bot or the platform.
 * - **First view** is the earliest first visit by anyone to the platform's review page.
 * - **Merge** is the pull request's `mergedAt`.
 *
 * Not measured, because no timestamp exists: when a person approved, how long they spent reading,
 * and how long a pull request sat after the last review round. A review-to-merge span is the
 * nearest stored proxy for the tail of the process; it includes everything between the first
 * review and the merge, CI and the author's fixes included.
 */

export const READY_FOR_REVIEW_TRIGGER = 'pull_request.ready_for_review';

export type ReviewTimeEvaluation = {
  changesRequestedCount: number;
  createdAt: Date;
  firstHumanReviewAt: Date | null;
  headSha: string;
  triggeredBy: string;
};

export type ReviewTimeInput = {
  evaluations: readonly ReviewTimeEvaluation[];
  firstViewedAt: Date | null;
  id: string;
  mergedAt: Date | null;
  openedAt: Date;
};

export type PullRequestReviewTime = {
  /** Reviews that asked for changes, summed over the pull request's heads. */
  changesRequested: number;
  firstHumanReviewAt: string | null;
  id: string;
  mergedAt: string | null;
  readyAt: string | null;
  /** Distinct heads a person reviewed. */
  reviewRounds: number;
  /** First human review to merge; null unless it merged after a recorded review. */
  reviewToMergeMs: number | null;
  /** Ready to first human review; null unless both exist. */
  timeToFirstReviewMs: number | null;
  /** Ready to first view on the review page; null unless both exist. */
  timeToFirstViewMs: number | null;
};

const earliest = (dates: readonly Date[]): Date | null =>
  dates.length === 0 ? null : new Date(Math.min(...dates.map((d) => d.getTime())));

/** A span whose end precedes its start (clock skew, a late write) reads as no wait. */
const span = (from: Date | null, to: Date | null): number | null =>
  from === null || to === null ? null : Math.max(0, to.getTime() - from.getTime());

export function reviewTimeOf(input: ReviewTimeInput): PullRequestReviewTime {
  const { evaluations } = input;
  const readyEvaluations = evaluations.filter((e) => e.triggeredBy === READY_FOR_REVIEW_TRIGGER);
  const readyAt = earliest(
    (readyEvaluations.length > 0 ? readyEvaluations : evaluations).map((e) => e.createdAt)
  );
  const reviewed = evaluations.filter((e) => e.firstHumanReviewAt !== null);
  const firstReview = earliest(reviewed.map((e) => e.firstHumanReviewAt as Date));
  const merged =
    input.mergedAt !== null && firstReview !== null ? span(firstReview, input.mergedAt) : null;
  return {
    changesRequested: evaluations.reduce((sum, e) => sum + e.changesRequestedCount, 0),
    firstHumanReviewAt: firstReview?.toISOString() ?? null,
    id: input.id,
    mergedAt: input.mergedAt?.toISOString() ?? null,
    readyAt: readyAt?.toISOString() ?? null,
    reviewRounds: new Set(reviewed.map((e) => e.headSha)).size,
    reviewToMergeMs: merged,
    timeToFirstReviewMs: span(readyAt, firstReview),
    timeToFirstViewMs: span(readyAt, input.firstViewedAt),
  };
}

export type DurationStats = { count: number; p50: number | null; p90: number | null };

export type ReviewTimeSummary = {
  /** Reviewed pull requests with at least one review asking for changes, over reviewed ones. */
  changeRequestRate: number | null;
  /** Fewer reviewed pull requests than {@link MIN_SAMPLES_FOR_SIGNIFICANCE}: treat as anecdote. */
  lowSample: boolean;
  /** Pull requests in the cohort. */
  pullRequests: number;
  reviewed: number;
  reviewRounds: { mean: number | null; median: number | null; max: number };
  reviewToMerge: DurationStats;
  timeToFirstReview: DurationStats;
  timeToFirstView: DurationStats;
  /** Pull requests with no evaluation, whose wait cannot be measured. */
  unmeasured: number;
};

function stats(values: readonly (number | null)[]): DurationStats {
  const present = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  return { count: present.length, p50: percentile(present, 0.5), p90: percentile(present, 0.9) };
}

/** Round to a thousandth, like the other shares in the reports. */
const share = (part: number, whole: number): number | null =>
  whole === 0 ? null : Math.round((part / whole) * 1000) / 1000;

export function summarizeReviewTime(rows: readonly PullRequestReviewTime[]): ReviewTimeSummary {
  const reviewed = rows.filter((row) => row.firstHumanReviewAt !== null);
  const rounds = reviewed.map((row) => row.reviewRounds).sort((a, b) => a - b);
  return {
    changeRequestRate: share(
      reviewed.filter((row) => row.changesRequested > 0).length,
      reviewed.length
    ),
    lowSample: reviewed.length < MIN_SAMPLES_FOR_SIGNIFICANCE,
    pullRequests: rows.length,
    reviewed: reviewed.length,
    reviewRounds: {
      max: rounds.length === 0 ? 0 : (rounds[rounds.length - 1] as number),
      mean:
        rounds.length === 0
          ? null
          : Math.round((rounds.reduce((a, b) => a + b, 0) / rounds.length) * 100) / 100,
      median: percentile(rounds, 0.5),
    },
    reviewToMerge: stats(rows.map((row) => row.reviewToMergeMs)),
    timeToFirstReview: stats(rows.map((row) => row.timeToFirstReviewMs)),
    timeToFirstView: stats(rows.map((row) => row.timeToFirstViewMs)),
    unmeasured: rows.filter((row) => row.readyAt === null).length,
  };
}
