import type { ChannelAssistantTurnInput } from '@auto-swe/shared/types/workflow';
import { log, proxyActivities, workflowInfo } from '@temporalio/workflow';
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

const CHANNEL_ERROR_TEXT =
  ":warning: Sorry, I hit an error working on that and couldn't finish. Please try again.";

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
    const { reply } = await runChannelAssistantTurn(input);
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
