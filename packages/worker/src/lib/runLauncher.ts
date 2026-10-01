import { prisma } from '@auto-swe/shared/db';
import { activityInfo } from '@temporalio/activity';

/**
 * The platform user who launched the execution the current activity belongs
 * to, or null when there is none.
 *
 * This decides whose saved GitHub credential a run may use, so it reads the
 * one record that says who started THIS execution: `WorkflowRun.launchedById`,
 * written from the workflow's own input by its first activity. Not
 * `RunInput.requestedById` — a re-run reuses the original request, and someone
 * re-running another person's work must not act as that person.
 *
 * And only when the row's `temporalRunId` is this execution's. The row is
 * upserted by workflow id and never rewritten, and a workflow id can be started
 * again once its earlier execution closes; a row left by that earlier execution
 * names its launcher, not ours.
 *
 * Null — and therefore the platform credential — when:
 *  - the caller is not inside a workflow-scheduled activity;
 *  - the workflow keeps no run row (the permission sweep, dependency scans,
 *    consolidation), so there is no launcher to act for;
 *  - the run was started by a webhook, a cron fire, or anything else with no
 *    platform user;
 *  - the row belongs to a different execution, or predates this column.
 *
 * A database failure throws rather than returning null. Null means "act as the
 * platform", and silently switching a user's run to the platform identity
 * because a query timed out is the wrong way round — the activity retries.
 */
export async function currentRunLauncherId(): Promise<string | null> {
  let execution: { workflowId: string; runId: string } | undefined;
  try {
    execution = activityInfo().workflowExecution;
  } catch {
    return null;
  }
  if (!execution) {
    return null;
  }
  const run = await prisma.workflowRun.findUnique({
    select: { launchedById: true, temporalRunId: true },
    where: { workflowId: execution.workflowId },
  });
  if (!run?.temporalRunId || run.temporalRunId !== execution.runId) {
    return null;
  }
  return run.launchedById;
}
