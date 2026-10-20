/**
 * Delivery figures for a cohort of pull requests: how many reached a merge,
 * how fast, and what state the rest are in. Pure — callers pass the rows.
 */
import type { PullRequestOutcomeSummary } from '../types/api.js';
import { percentile } from '../workflow/analytics.js';

/** The `PullRequest` fields a summary reads. */
export interface PullRequestOutcomeRow {
  status: string;
  ciStatus: string;
  isDraft: boolean;
  openedAt: Date;
  mergedAt: Date | null;
}

/**
 * Summarises a cohort. `mergeRate` counts only PRs that resolved; time to merge
 * ignores a merge with no `mergedAt` or one dated before it opened.
 */
export function summarizePullRequestOutcomes(
  rows: readonly PullRequestOutcomeRow[]
): PullRequestOutcomeSummary {
  let merged = 0;
  let closedUnmerged = 0;
  let open = 0;
  let draftCount = 0;
  const ciStatusCounts: Record<string, number> = {};
  const durations: number[] = [];
  for (const row of rows) {
    if (row.status === 'MERGED') {
      merged++;
      if (row.mergedAt) {
        const ms = row.mergedAt.getTime() - row.openedAt.getTime();
        if (ms >= 0) {
          durations.push(ms);
        }
      }
    } else if (row.status === 'CLOSED') {
      closedUnmerged++;
    } else {
      open++;
    }
    if (row.isDraft) {
      draftCount++;
    }
    ciStatusCounts[row.ciStatus] = (ciStatusCounts[row.ciStatus] ?? 0) + 1;
  }
  durations.sort((a, b) => a - b);
  const resolved = merged + closedUnmerged;
  return {
    ciStatusCounts,
    closedUnmerged,
    draftCount,
    merged,
    mergeRate: resolved === 0 ? null : merged / resolved,
    open,
    opened: rows.length,
    timeToMergeMs: {
      count: durations.length,
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
    },
  };
}
