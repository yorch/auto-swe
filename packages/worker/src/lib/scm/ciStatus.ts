/**
 * Pure normalization of GitHub CI signals into a single verdict.
 *
 * Two independent GitHub surfaces report CI state:
 *   - Check runs (the Checks API — GitHub Actions, GitHub App checks)
 *   - Commit statuses (the legacy Statuses API — Travis, CircleCI, etc.)
 *
 * The poller queries both and folds them into one of four verdicts. Kept as a
 * pure function (no Octokit, no I/O) so the precedence rules are unit-testable
 * without a network or fake clients.
 */

export type CiVerdict = 'passed' | 'failed' | 'pending' | 'none';

/** Minimal shape of a check-run we care about (subset of Octokit's type). */
export interface CiCheckRun {
  /** queued | in_progress | completed */
  status: string;
  /** success | failure | neutral | cancelled | timed_out | action_required | skipped | stale | null */
  conclusion: string | null;
  /** Web URL to the check, used as the logs link on failure. */
  htmlUrl?: string | null;
}

/** Minimal shape of the combined commit status (subset of Octokit's type). */
export interface CiCombinedStatus {
  /** success | pending | failure | error */
  state: string;
  /** Number of individual statuses contributing to `state` (0 → no statuses). */
  totalCount: number;
  targetUrl?: string | null;
}

const FAILED_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'stale',
]);
// success / neutral / skipped are all "not a failure" for gating purposes.
const FAILED_STATES = new Set(['failure', 'error']);

/**
 * Fold check-runs + combined status into a single verdict.
 *
 * Precedence (first match wins):
 *  1. `failed`  — any check-run concluded failure-ish, or combined state is failure/error.
 *  2. `none`    — zero check-runs AND zero commit statuses (repo has no CI at all).
 *  3. `pending` — any check-run not yet `completed`, or combined state still `pending`
 *                 while statuses exist.
 *  4. `passed`  — everything present has resolved successfully.
 */
export function normalizeCiStatus(checkRuns: CiCheckRun[], combined: CiCombinedStatus): CiVerdict {
  const anyFailed =
    checkRuns.some((r) => r.conclusion != null && FAILED_CONCLUSIONS.has(r.conclusion)) ||
    FAILED_STATES.has(combined.state);
  if (anyFailed) {
    return 'failed';
  }

  if (checkRuns.length === 0 && combined.totalCount === 0) {
    return 'none';
  }

  const anyPending =
    checkRuns.some((r) => r.status !== 'completed') ||
    (combined.state === 'pending' && combined.totalCount > 0);
  if (anyPending) {
    return 'pending';
  }

  return 'passed';
}

/** First failed check's URL (or the combined status target) for the logs link. */
export function pickLogsUrl(
  checkRuns: CiCheckRun[],
  combined: CiCombinedStatus
): string | undefined {
  const failed = checkRuns.find(
    (r) => r.conclusion != null && FAILED_CONCLUSIONS.has(r.conclusion)
  );
  return failed?.htmlUrl ?? combined.targetUrl ?? undefined;
}
