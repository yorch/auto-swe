import { CHANNEL_TASK_STEER_SIGNAL } from '@auto-swe/shared/lib/channelTask';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import {
  type ChildWorkflowHandle,
  defineSignal,
  log,
  setHandler,
  sleep,
  type Workflow,
  workflowInfo,
} from '@temporalio/workflow';
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
 * STEERING: a thread reply reaches this wrapper via the shared `steer` signal
 * (the gateway reconstructs the same `chantask-` id and signals it for the whole
 * task lifetime, with no DB lookup). Before the run launches, steering text is
 * folded into the task description. After it launches, this wrapper stays alive
 * and forwards each new reply straight to the running child run — so a deferred
 * task is steerable in-flight exactly like an immediate one (Gap D). Holding the
 * per-thread id for the task's whole life also keeps "one task per thread" intact
 * (a re-delegate is rejected), mirroring the immediate path where the
 * `RunnableWorkflow` itself owns the per-thread id.
 *
 * V8-isolate rule: only `import type` from external packages / `@auto-swe/shared`;
 * runtime imports come from `@temporalio/workflow` only.
 */
export async function ChannelScheduledTaskWorkflow(
  input: ChannelScheduledTaskInput
): Promise<void> {
  // Before launch: buffer steering to fold into the task description. After
  // launch: forward each reply straight to the running child run.
  const preSteers: string[] = [];
  let childHandle: ChildWorkflowHandle<Workflow> | undefined;
  setHandler(steerSignal, async (msg: string) => {
    const trimmed = msg.trim();
    if (trimmed.length === 0) {
      return;
    }
    if (childHandle) {
      await childHandle.signal(steerSignal, trimmed);
    } else {
      preSteers.push(trimmed);
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

  // Freeze the description with the steering gathered so far, then launch. Steers
  // that arrive after this point (during child startup or the run) are forwarded
  // live below, not folded here.
  const folded = preSteers.length;
  const request =
    folded > 0
      ? {
          ...input.request,
          description: `${input.request.description}\n\nAdditional guidance:\n${preSteers
            .slice(0, folded)
            .join('\n')}`,
        }
      : input.request;

  // Private per-thread run id — only this wrapper ever starts it, so it never
  // collides with the wrapper's own id.
  const taskRunWorkflowId = `${workflowInfo().workflowId}-run`;

  try {
    childHandle = await startThreadTaskChild(
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

  // Forward any steering that landed during child startup — after the description
  // was frozen but before `childHandle` was set, so the handler buffered it into
  // `preSteers` instead of forwarding. Drains that narrow window so no reply is
  // lost in the handoff.
  for (const straggler of preSteers.slice(folded)) {
    await childHandle.signal(steerSignal, straggler);
  }

  // Stay alive for the task's whole life so post-launch thread replies keep
  // reaching the running child via the handler above, and the per-thread id stays
  // reserved (one task per thread). The child runs under ABANDON, so it survives
  // even if this wrapper is later terminated; awaiting its result is purely to
  // hold the steering bridge open. A child failure isn't this wrapper's to
  // surface (the run reports its own outcome) — log and close cleanly.
  try {
    await childHandle.result();
  } catch (err) {
    log.info('ChannelScheduledTaskWorkflow: child run ended with error', {
      err: err instanceof Error ? err.message : String(err),
      taskRunWorkflowId,
    });
  }
}
