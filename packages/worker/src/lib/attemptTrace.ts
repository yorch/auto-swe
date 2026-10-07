import { activityInfo } from '@temporalio/activity';

/**
 * The trace event a CI fix session records about the failure it was asked to
 * fix: `outputJson.logTail`, the end of the CI logs it was handed, and
 * `outputJson.activityId` (see {@link currentActivityId}).
 *
 * A CI loop keeps only its latest logs in the workflow's context, and the
 * `WorkflowStep` row of each loop node is overwritten on every revisit, so this
 * row is what lets a lesson about a run that failed CI several times see each
 * failure (`lib/lessonAttemptHistory.ts`). The fix session's own prompt row
 * holds the logs too, but after the previous diff and cut at the trace's
 * per-string limit, which loses the end of a long log, where the failure is.
 */
export const CI_FAILURE_TRACE_EVENT = 'ci_fix.failure_logs';

/** Characters of the log's end the event keeps. */
export const CI_FAILURE_TRACE_CHARS = 4_000;

/**
 * Temporal's id for the current activity, or null outside one. It is the same
 * on every retry of one scheduled activity and differs between schedulings, so
 * trace rows that carry it in `outputJson.activityId` (the CI failure event and
 * the review network's verdict rows) tell a retry of one fix or review apart
 * from the next visit to the same loop node.
 */
export function currentActivityId(): string | null {
  try {
    return activityInfo().activityId;
  } catch {
    return null;
  }
}
