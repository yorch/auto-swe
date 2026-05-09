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
