import { ParentClosePolicy, startChild, WorkflowIdReusePolicy } from '@temporalio/workflow';

/**
 * Start a channel-thread task as a child workflow under the shared launch
 * contract: ABANDON parent-close (the task must outlive the short turn / wrapper
 * that starts it), the `engineering-workflow` task queue, and REJECT_DUPLICATE on
 * a deterministic per-thread workflowId (one task per thread; a re-delegate is
 * rejected and surfaced as an honest "already a task here" message).
 *
 * Centralises those three load-bearing invariants so the immediate path
 * (`ChannelAssistantWorkflow` → `RunnableWorkflow`), the deferred wrapper
 * (`ChannelAssistantWorkflow` → `ChannelScheduledTaskWorkflow`), and the deferred
 * run (`ChannelScheduledTaskWorkflow` → `RunnableWorkflow`) can't drift on policy.
 *
 * Isolate-safe: only runtime imports from `@temporalio/workflow`, so it bundles
 * into the workflow V8 isolate.
 */
export async function startThreadTaskChild(
  workflowType: string,
  args: unknown[],
  workflowId: string
): Promise<void> {
  await startChild(workflowType, {
    args,
    parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
    taskQueue: 'engineering-workflow',
    workflowId,
    workflowIdReusePolicy: WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
  });
}
