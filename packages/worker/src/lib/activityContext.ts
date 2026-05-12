import { prisma } from '@auto-swe/shared/db';
import { activityInfo } from '@temporalio/activity';

/**
 * Returns the Temporal workflow ID that scheduled the current activity.
 *
 * `Info.workflowExecution` is typed as optional because the Temporal SDK
 * supports activities started outside a workflow (e.g. raw `ActivityClient`
 * use). Every activity in this codebase is workflow-driven, so a missing
 * value is a programmer error — fail loudly rather than passing `undefined`
 * downstream.
 */
export function currentWorkflowId(): string {
  const execution = activityInfo().workflowExecution;
  if (!execution) {
    throw new Error(
      'currentWorkflowId() called outside of a workflow-scheduled activity (Info.workflowExecution is undefined)'
    );
  }
  return execution.workflowId;
}

/**
 * Look up the `WorkflowRun.id` row for the currently executing Temporal
 * workflow so artifacts produced by an activity link back to the run. Returns
 * undefined when no row exists yet (race against `createWorkflowRun`) or when
 * the lookup fails — artifact persistence is best-effort.
 */
export async function currentWorkflowRunId(): Promise<string | undefined> {
  try {
    const wid = currentWorkflowId();
    const run = await prisma.workflowRun.findUnique({
      select: { id: true },
      where: { workflowId: wid },
    });
    return run?.id;
  } catch {
    return undefined;
  }
}
