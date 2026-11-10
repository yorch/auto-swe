import { RISK_RANK, type RoutingDecision, riskRank } from './reviewRouting.js';
import type { RiskClass } from './types.js';

/**
 * The order in which a reviewer should meet the open pull requests, and the batches that order
 * falls into. A pure function of the routing decision and of facts the evaluation recorded, so
 * the same queue always reads the same way.
 *
 * Batches, in the order they are shown:
 *
 * - `deep`: needs a person, and is `HIGH` risk or has no usable evaluation (unevaluated, or
 *   evaluated at an older head). Fail-closed: not knowing the risk is read as the highest.
 * - `standard`: needs a person, `STANDARD` risk, or `LOW` but larger than the quick-review size.
 * - `quick`: needs a person, `LOW` and at most the quick-review size. Smallest first, so a
 *   reviewer can clear a run of them in one sitting.
 * - `none`: needs no person: a draft, enough approvals already, a standing bot approval, or
 *   below every routing threshold. Listed last so the list is still complete.
 */
export const REVIEW_BATCHES = ['deep', 'standard', 'quick', 'none'] as const;
export type ReviewBatch = (typeof REVIEW_BATCHES)[number];

const BATCH_RANK: Record<ReviewBatch, number> = { deep: 0, none: 3, quick: 2, standard: 1 };

export type QueueItem = {
  /** Changed lines recorded by the evaluation; null when none is usable. */
  changedLines: number | null;
  decision: RoutingDecision;
  id: string;
  openedAt: Date;
  quickReviewMaxLines: number;
  /** Null when the pull request has no evaluation at the current head. */
  riskClass: RiskClass | null;
};

export type QueueEntry = {
  batch: ReviewBatch;
  id: string;
  /** 1-based place in the whole ordered queue. */
  position: number;
};

/** The batch one pull request belongs to. */
export function reviewBatchOf(item: QueueItem): ReviewBatch {
  if (!item.decision.needsHuman) {
    return 'none';
  }
  if (item.riskClass === null || item.riskClass === 'HIGH') {
    return 'deep';
  }
  if (
    item.riskClass === 'LOW' &&
    item.changedLines !== null &&
    item.changedLines <= item.quickReviewMaxLines
  ) {
    return 'quick';
  }
  return 'standard';
}

/** An unknown risk reads as the highest, like everywhere else evaluation fails closed. */
const riskRankOf = (risk: RiskClass | null): number =>
  risk === null ? RISK_RANK.HIGH : riskRank(risk);

/**
 * Order the queue: batch first, then within a batch higher risk first, then (outside `quick`)
 * the longest-waiting first, and inside `quick` the smallest change first. Ties break on the
 * opening time, then the id, so the order is total and stable across reads.
 */
export function orderReviewQueue(items: readonly QueueItem[]): QueueEntry[] {
  const batched = items.map((item) => ({ batch: reviewBatchOf(item), item }));
  batched.sort((a, b) => {
    if (a.batch !== b.batch) {
      return BATCH_RANK[a.batch] - BATCH_RANK[b.batch];
    }
    const risk = riskRankOf(b.item.riskClass) - riskRankOf(a.item.riskClass);
    if (risk !== 0) {
      return risk;
    }
    if (a.batch === 'quick') {
      const lines = (a.item.changedLines ?? 0) - (b.item.changedLines ?? 0);
      if (lines !== 0) {
        return lines;
      }
    }
    const age = a.item.openedAt.getTime() - b.item.openedAt.getTime();
    if (age !== 0) {
      return age;
    }
    return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
  });
  return batched.map(({ batch, item }, index) => ({ batch, id: item.id, position: index + 1 }));
}

export type ReviewQueueSummary = {
  batches: Record<ReviewBatch, number>;
  needsHuman: number;
  open: number;
  /** Age in ms of the longest-waiting pull request that needs a person; null with none. */
  oldestWaitingMs: number | null;
  /** Median age in ms of those that need a person; null with none. */
  medianWaitingMs: number | null;
};

/** Counts for the pull requests in a queue, judged at `now`. */
export function summarizeReviewQueue(items: readonly QueueItem[], now: Date): ReviewQueueSummary {
  const batches: Record<ReviewBatch, number> = { deep: 0, none: 0, quick: 0, standard: 0 };
  const waits: number[] = [];
  for (const item of items) {
    batches[reviewBatchOf(item)] += 1;
    if (item.decision.needsHuman) {
      waits.push(Math.max(0, now.getTime() - item.openedAt.getTime()));
    }
  }
  waits.sort((a, b) => a - b);
  const mid = Math.floor(waits.length / 2);
  const median =
    waits.length === 0
      ? null
      : waits.length % 2 === 1
        ? (waits[mid] as number)
        : Math.round(((waits[mid - 1] as number) + (waits[mid] as number)) / 2);
  return {
    batches,
    medianWaitingMs: median,
    needsHuman: waits.length,
    oldestWaitingMs: waits.length === 0 ? null : (waits[waits.length - 1] as number),
    open: items.length,
  };
}
