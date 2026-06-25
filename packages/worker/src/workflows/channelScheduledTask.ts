import { CHANNEL_TASK_STEER_SIGNAL } from '@auto-swe/shared/lib/channelTask';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { defineSignal, log, setHandler, sleep, workflowInfo } from '@temporalio/workflow';
import { startThreadTaskChild } from './taskChild.js';

/**
 * Input for ChannelScheduledTaskWorkflow.
 * Carries everything needed to start the deferred RunnableWorkflow child.
 */
export interface ChannelScheduledTaskInput {
  /** ISO 8601 UTC timestamp at which the task should start executing. */
  runAt: string;
  templateId: string;
  templateVersion: number;
  /** The fully-formed run request the child `RunnableWorkflow` consumes. */
  request: RepoWorkRequest;
}

const steerSignal = defineSignal<[string]>(CHANNEL_TASK_STEER_SIGNAL);

/**
 * ChannelScheduledTaskWorkflow — channel assistant (Gap D: deferred task execution).
 *
 * Sleeps until `runAt`, then launches the actual task as a `RunnableWorkflow`
 * child. Started by `ChannelAssistantWorkflow` when the agent calls `delegateTask`
 * with an explicit future `runAt`.
 *
 * IDENTITY (one task per thread, immediate OR deferred): this wrapper runs under
 * the SAME deterministic per-thread id as an immediate task —
 * `chantask-<channelId>-<threadTs>` (`channelTaskWorkflowId`) — started with
 * REJECT_DUPLICATE. So a second delegate in the thread (immediate or deferred) is
 * rejected by Temporal and surfaced as "already a task in this thread" by the
 * caller, exactly like the immediate path. The actual run is started under a
 * private `<id>-run` child id, which the wrapper alone ever uses — so there is no
 * id collision between the wrapper and its child.
 *
 * STEERING: a thread reply during the wait reaches this wrapper via the shared
 * `steer` signal (the gateway reconstructs the same `chantask-` id). Steering text
 * is appended to the task description before launch, so deferred tasks honour
 * mid-wait refinements.
 *
 * V8-isolate rule: only `import type` from external packages / `@auto-swe/shared`;
 * runtime imports come from `@temporalio/workflow` only.
 */
export async function ChannelScheduledTaskWorkflow(
  input: ChannelScheduledTaskInput
): Promise<void> {
  // Collect any steering refinements that arrive while we wait.
  const steers: string[] = [];
  setHandler(steerSignal, (msg: string) => {
    if (msg.trim().length > 0) {
      steers.push(msg.trim());
    }
  });

  // `new Date(...)`/`Date.now()` are deterministic inside a Temporal workflow (the
  // SDK patches them against the replay clock). Guard against an invalid runAt:
  // an unparseable timestamp yields NaN — treat it (and any past time) as "run now"
  // rather than silently skipping or hanging.
  const runAtMs = new Date(input.runAt).getTime();
  const delayMs = Number.isFinite(runAtMs) ? runAtMs - Date.now() : 0;

  if (delayMs > 0) {
    log.info('ChannelScheduledTaskWorkflow: sleeping until runAt', {
      delayMs,
      runAt: input.runAt,
    });
    await sleep(delayMs);
  }

  // Fold any mid-wait steering into the task description before launch.
  const request =
    steers.length > 0
      ? {
          ...input.request,
          description: `${input.request.description}\n\nAdditional guidance:\n${steers.join('\n')}`,
        }
      : input.request;

  // Private per-thread run id — only this wrapper ever starts it, so it never
  // collides with the wrapper's own id.
  const taskRunWorkflowId = `${workflowInfo().workflowId}-run`;

  try {
    await startThreadTaskChild(
      'RunnableWorkflow',
      [{ request, templateId: input.templateId, templateVersion: input.templateVersion }],
      taskRunWorkflowId
    );
  } catch (err) {
    // Best-effort: a failed launch (e.g. template removed) must not crash silently
    // without a trace. The wrapper is abandoned by its parent, so there's nothing
    // to report back to — log for observability.
    log.error('ChannelScheduledTaskWorkflow: failed to launch deferred task run', {
      err: err instanceof Error ? err.message : String(err),
      taskRunWorkflowId,
    });
    throw err;
  }
}
