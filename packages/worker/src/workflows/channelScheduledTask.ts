import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import {
  log,
  ParentClosePolicy,
  sleep,
  startChild,
  WorkflowIdReusePolicy,
} from '@temporalio/workflow';

/**
 * Input for ChannelScheduledTaskWorkflow.
 * Carries everything needed to start the deferred RunnableWorkflow child.
 */
export interface ChannelScheduledTaskInput {
  /** ISO 8601 UTC timestamp at which the task should start executing. */
  runAt: string;
  /** Temporal workflowId for the child `RunnableWorkflow` (one per thread). */
  taskWorkflowId: string;
  templateId: string;
  templateVersion: number;
  /** The fully-formed run request the child `RunnableWorkflow` consumes. */
  request: RepoWorkRequest;
}

/**
 * ChannelScheduledTaskWorkflow — channel assistant (Gap D: deferred task execution).
 *
 * Sleeps until `runAt`, then launches a thread-bound `RunnableWorkflow` exactly
 * as the immediate path does. Started by `ChannelAssistantWorkflow` when the
 * agent calls `delegateTask` with an explicit future `runAt` timestamp.
 *
 * Workflow ID is `chansched-<channelId>-<threadTs>` — one scheduled slot per
 * thread, REJECT_DUPLICATE so a second schedule attempt in the same thread is
 * surfaced as "already running" by the caller (not silently clobbered).
 *
 * V8-isolate rule: only `import type` from external packages / `@auto-swe/shared`;
 * runtime imports come from `@temporalio/workflow` only.
 */
export async function ChannelScheduledTaskWorkflow(
  input: ChannelScheduledTaskInput
): Promise<void> {
  const runAtMs = new Date(input.runAt).getTime();
  const delayMs = runAtMs - Date.now();

  if (delayMs > 0) {
    log.info('ChannelScheduledTaskWorkflow: sleeping until runAt', {
      delayMs,
      runAt: input.runAt,
      taskWorkflowId: input.taskWorkflowId,
    });
    await sleep(delayMs);
  }

  await startChild('RunnableWorkflow', {
    args: [
      {
        request: input.request,
        templateId: input.templateId,
        templateVersion: input.templateVersion,
      },
    ],
    parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
    taskQueue: 'engineering-workflow',
    workflowId: input.taskWorkflowId,
    workflowIdReusePolicy: WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
  });
}
