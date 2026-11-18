import { orchestrationWorkflowId } from '@auto-swe/shared/lib/orchestration';
import { ApplicationFailure, activityInfo } from '@temporalio/activity';

/**
 * The orchestration workflow acts for exactly one orchestration, and its Temporal workflow id is
 * `orch-<orchestrationId>`. Nothing in the workflow's input proves the two belong together: whoever
 * can start a workflow on the task queue chooses both. The activity that begins a run therefore
 * refuses unless the id of the workflow that scheduled it is the one the orchestration owns, so a
 * workflow started under any other id (or under another orchestration's id) does nothing. The
 * check lives in an activity rather than the workflow so replaying histories recorded under other
 * ids stays deterministic.
 */

/** Non-retryable refusal type, so the workflow fails at once instead of retrying. */
export const ORCHESTRATION_WORKFLOW_MISMATCH = 'ORCHESTRATION_WORKFLOW_MISMATCH';

/** Throw unless `workflowId` is the workflow id the orchestration owns. */
export function assertOwnWorkflowId(orchestrationId: string, workflowId: string): void {
  if (workflowId !== orchestrationWorkflowId(orchestrationId)) {
    throw ApplicationFailure.nonRetryable(
      'This workflow is not the one that owns the orchestration',
      ORCHESTRATION_WORKFLOW_MISMATCH
    );
  }
}

/**
 * {@link assertOwnWorkflowId} for the workflow that scheduled the running activity. Outside an
 * activity (a unit test calling the function directly) there is no workflow to judge and nothing is
 * checked; inside one, a missing workflow id is a refusal.
 */
export function assertCurrentWorkflowOwns(orchestrationId: string): void {
  let info: ReturnType<typeof activityInfo>;
  try {
    info = activityInfo();
  } catch {
    return;
  }
  assertOwnWorkflowId(orchestrationId, info.workflowExecution?.workflowId ?? '');
}
