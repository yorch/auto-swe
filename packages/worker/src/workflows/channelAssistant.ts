import type { ChannelAssistantTurnInput } from '@auto-swe/shared/types/workflow';
import {
  log,
  ParentClosePolicy,
  proxyActivities,
  startChild,
  WorkflowIdReusePolicy,
  workflowInfo,
} from '@temporalio/workflow';
import type { DelegateIntent } from '../activities/channelAssistant.js';
import type * as activitiesType from '../activities/index.js';

/**
 * ChannelAssistantWorkflow — channel assistant (Phase 0 + Phase 4 live-progress).
 *
 * One @mention → one reply. The gateway's Slack Events route starts this
 * workflow (name `'ChannelAssistantWorkflow'`, task queue `'engineering-workflow'`)
 * when a user @mentions the bot; it runs the channel's assistant agent and posts
 * the reply back into the originating thread.
 *
 * Phase 4 (multiplayer polish) gives the teammate a "live" feel: a placeholder
 * (":hourglass_flowing_sand: _Working on it…_") is posted into the thread first,
 * then edited in place (chat.update) with the answer once the turn finishes. If
 * the placeholder couldn't be posted we fall back to a fresh reply message; on a
 * turn error we edit the placeholder (or post a fresh message) with friendly
 * error text — preserving the original graceful-fallback behavior.
 *
 * Scope note: true mid-task hand-off and full thread-history context (fetching
 * `conversations.replies`) need a Slack read scope + a long-lived per-channel
 * workflow; they remain future refinements. The shared per-channel agent +
 * channel memory already make the assistant multiplayer (one Claude, shared
 * context) — this phase adds the live-edit UX + input safety (advisory scan of
 * ingested channel content inside `runChannelAssistantTurn`).
 *
 * V8-isolate rule: only `import type` from external packages / `@auto-swe/shared`;
 * runtime imports come from `@temporalio/workflow` and the activity proxies below.
 */

// The LLM turn: generous timeout + a couple retries (transient provider errors).
const { runChannelAssistantTurn } = proxyActivities<
  Pick<typeof activitiesType, 'runChannelAssistantTurn'>
>({
  heartbeatTimeout: '2m',
  retry: {
    backoffCoefficient: 2,
    initialInterval: '5s',
    maximumAttempts: 3,
    maximumInterval: '1m',
  },
  startToCloseTimeout: '5m',
});

// The Slack posts: quick network calls. Retry a few times so a transient blip
// doesn't drop the reply, but keep the per-attempt timeout short. The placeholder
// poster and the chat.update editor share these settings with the fresh-post path.
const { postChannelReply, postChannelPlaceholder, updateChannelReply } = proxyActivities<
  Pick<typeof activitiesType, 'postChannelReply' | 'postChannelPlaceholder' | 'updateChannelReply'>
>({
  retry: {
    backoffCoefficient: 2,
    initialInterval: '2s',
    maximumAttempts: 4,
    maximumInterval: '30s',
  },
  startToCloseTimeout: '30s',
});

// Run-record lifecycle: a lightweight WorkflowRun keyed to this Temporal
// workflowId so the turn's agent traces (LLM calls inside runChannelAssistantTurn)
// persist + show up in /runs. Quick DB writes — short timeout, a couple retries.
const { startChannelRun, finalizeChannelRun } = proxyActivities<
  Pick<typeof activitiesType, 'startChannelRun' | 'finalizeChannelRun'>
>({
  retry: {
    backoffCoefficient: 2,
    initialInterval: '2s',
    maximumAttempts: 3,
    maximumInterval: '30s',
  },
  startToCloseTimeout: '30s',
});

// Phase A: task-launch preparation + budget gate. Quick DB reads/writes — short
// timeout, a couple retries. `createChannelTaskRun` is NOT idempotent (it INSERTs
// a RunInput), but it only runs once per turn (guarded by the `delegate` branch),
// and a duplicate RunInput would be harmless (the reject-duplicate child policy
// keeps a single task run per thread regardless).
const { createChannelTaskRun, isChannelOverBudgetForTask } = proxyActivities<
  Pick<typeof activitiesType, 'createChannelTaskRun' | 'isChannelOverBudgetForTask'>
>({
  retry: {
    backoffCoefficient: 2,
    initialInterval: '2s',
    maximumAttempts: 3,
    maximumInterval: '30s',
  },
  startToCloseTimeout: '30s',
});

const CHANNEL_ERROR_TEXT =
  ":warning: Sorry, I hit an error working on that and couldn't finish. Please try again.";

// Phase A: posted instead of launching a task when the channel is over budget.
const CHANNEL_TASK_BUDGET_TEXT =
  ':moneybag: This channel has reached its monthly assistant budget, so I can ' +
  'not start that task right now. An admin can raise the cap in the dashboard.';

export async function ChannelAssistantWorkflow(input: ChannelAssistantTurnInput): Promise<void> {
  // 0. Create the run record FIRST (keyed to this Temporal workflowId) so the
  //    turn's agent traces resolve a runId and persist. Best-effort: a failure
  //    here must not block the user's reply — traces are observability, not the
  //    product. We still try to finalize at the end.
  const workflowId = workflowInfo().workflowId;
  try {
    await startChannelRun({
      channelId: input.channelId,
      kind: 'mention',
      label: input.slackChannelId,
      orgId: input.orgId,
      teamId: input.teamId,
      workflowId,
    });
  } catch (err) {
    log.warn('ChannelAssistantWorkflow: startChannelRun failed; traces may not persist', {
      channelId: input.channelId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  let runStatus: 'SUCCESS' | 'FAILED' = 'SUCCESS';
  try {
    runStatus = await runTurn(input);
  } catch {
    // runTurn only rethrows when even the fallback delivery failed.
    runStatus = 'FAILED';
  } finally {
    // Finalize the run record with the terminal status + summed trace cost/tokens.
    // Best-effort; a finalize failure must not surface to the user.
    try {
      await finalizeChannelRun({ status: runStatus, workflowId });
    } catch (err) {
      log.warn('ChannelAssistantWorkflow: finalizeChannelRun failed', {
        channelId: input.channelId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * The turn itself: post a placeholder, run the LLM turn, deliver the reply (or a
 * friendly error). Extracted so the run-record lifecycle can wrap it cleanly.
 * Returns the terminal run status — `'FAILED'` when the LLM turn threw (even
 * though we still delivered a friendly fallback to the user), `'SUCCESS'`
 * otherwise. Throws only when even the fallback delivery fails.
 */
async function runTurn(input: ChannelAssistantTurnInput): Promise<'SUCCESS' | 'FAILED'> {
  // 1. Post a placeholder into the thread immediately so the user sees the
  //    teammate "working". Best-effort: if it fails or returns no ts, we fall
  //    back to a fresh reply message below (placeholderTs stays null).
  let placeholderTs: string | null = null;
  try {
    const placeholder = await postChannelPlaceholder({
      slackChannelId: input.slackChannelId,
      threadTs: input.threadTs,
    });
    placeholderTs = placeholder.ts;
  } catch (err) {
    log.warn('ChannelAssistantWorkflow: placeholder post failed; will post a fresh reply', {
      channelId: input.channelId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Run the LLM turn, then 3. deliver the reply: edit the placeholder in place
  //    when we have its ts, otherwise post a fresh message. On error, do the same
  //    with friendly error text (preserving the graceful-fallback behavior).
  try {
    const { reply, delegate } = await runChannelAssistantTurn(input);

    // Phase A: the agent asked to launch a durable task. Gate on the channel
    // budget, then start a thread-bound RunnableWorkflow that works the task and
    // reports its result back in this thread. We DO NOT await the child — the
    // task must outlive this short turn (abandon close policy).
    if (delegate) {
      const overBudget = await isChannelOverBudgetForTask(input.channelId);
      if (overBudget) {
        // Over budget: don't launch; tell the user instead of the agent's ack.
        await deliver(input, placeholderTs, CHANNEL_TASK_BUDGET_TEXT);
        return 'SUCCESS';
      }
      await launchTask(input, delegate);
    }

    // Always post the agent's reply (the "on it" ack when it delegated).
    await deliver(input, placeholderTs, reply);
    return 'SUCCESS';
  } catch (err) {
    log.error('ChannelAssistantWorkflow failed; posting fallback to thread', {
      channelId: input.channelId,
      err: err instanceof Error ? err.message : String(err),
    });
    // Don't leave the user hanging. Best-effort: if even this fails, let the
    // error surface so the run is recorded as failed (the outer catch maps it).
    await deliver(input, placeholderTs, CHANNEL_ERROR_TEXT);
    // We recovered (the fallback was delivered) but the turn itself failed —
    // record the run as FAILED for observability.
    return 'FAILED';
  }
}

/**
 * Deliver `text` to the thread: edit the placeholder in place (chat.update) when
 * we have its ts, otherwise post a fresh reply message.
 */
async function deliver(
  input: ChannelAssistantTurnInput,
  placeholderTs: string | null,
  text: string
): Promise<void> {
  if (placeholderTs) {
    await updateChannelReply({ slackChannelId: input.slackChannelId, text, ts: placeholderTs });
  } else {
    await postChannelReply({
      slackChannelId: input.slackChannelId,
      text,
      threadTs: input.threadTs,
    });
  }
}

/**
 * Phase A: launch a durable, thread-bound task run from a delegate intent.
 * Prepares the RunInput + launch params via `createChannelTaskRun`, then starts
 * a child `RunnableWorkflow` that works the task and reports its result back in
 * this thread (via the run's terminal Slack notification on the originating
 * RunInput's `slackChannelId`/`slackMessageTs`).
 *
 * Key Temporal semantics:
 *  - `PARENT_CLOSE_POLICY_ABANDON` + NO `await handle.result()` — the task run
 *    must OUTLIVE this short ChannelAssistantWorkflow turn (the turn finishes as
 *    soon as the ack is posted; the task may run for minutes).
 *  - `REJECT_DUPLICATE` reuse policy on the deterministic per-thread workflowId
 *    means a second delegate in the same thread is rejected rather than
 *    clobbering the in-flight task. We swallow that rejection (and any other
 *    launch error) so it never breaks the user's ack — the task is best-effort
 *    from the turn's perspective.
 *
 * Phase A only ships the GENERAL task route. A `route: 'code'` intent is captured
 * but still launched through the same general Channel Task spec for now (Phase B
 * wires the code/PR route through the SWE workflow); we log it so the deferral is
 * visible. This keeps a 'code' pick from breaking the flow.
 */
async function launchTask(
  input: ChannelAssistantTurnInput,
  delegate: DelegateIntent
): Promise<void> {
  if (delegate.route === 'code') {
    log.info('ChannelAssistantWorkflow: code-route task launched via general spec (Phase A)', {
      channelId: input.channelId,
      title: delegate.title,
    });
  }
  try {
    const { workflowId, templateId, templateVersion, request } = await createChannelTaskRun({
      channelId: input.channelId,
      description: delegate.description,
      slackChannelId: input.slackChannelId,
      threadTs: input.threadTs,
      title: delegate.title,
    });

    await startChild('RunnableWorkflow', {
      args: [{ request, templateId, templateVersion }],
      parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
      taskQueue: 'engineering-workflow',
      workflowId,
      // One task run per thread — a re-delegate in the same thread is rejected
      // rather than starting a second competing run.
      workflowIdReusePolicy: WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
    });
  } catch (err) {
    // Best-effort: a launch failure (incl. REJECT_DUPLICATE for an already-running
    // task in this thread) must not break the ack we still post to the user.
    log.warn('ChannelAssistantWorkflow: task launch failed; ack still delivered', {
      channelId: input.channelId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
