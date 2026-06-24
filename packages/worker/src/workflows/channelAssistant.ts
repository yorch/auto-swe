import type { ChannelAssistantTurnInput } from '@auto-swe/shared/types/workflow';
import { log, proxyActivities } from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';

/**
 * ChannelAssistantWorkflow — Claude Tag (Phase 0).
 *
 * One @mention → one reply. The gateway's Slack Events route starts this
 * workflow (name `'ChannelAssistantWorkflow'`, task queue `'engineering-workflow'`)
 * when a user @mentions the bot; it runs the channel's assistant agent and posts
 * the reply back into the originating thread.
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

// The Slack post: a quick network call. Retry a few times so a transient blip
// doesn't drop the reply, but keep the per-attempt timeout short.
const { postChannelReply } = proxyActivities<Pick<typeof activitiesType, 'postChannelReply'>>({
  retry: {
    backoffCoefficient: 2,
    initialInterval: '2s',
    maximumAttempts: 4,
    maximumInterval: '30s',
  },
  startToCloseTimeout: '30s',
});

export async function ChannelAssistantWorkflow(input: ChannelAssistantTurnInput): Promise<void> {
  try {
    const { reply } = await runChannelAssistantTurn(input);
    await postChannelReply({
      slackChannelId: input.slackChannelId,
      text: reply,
      threadTs: input.threadTs,
    });
  } catch (err) {
    log.error('ChannelAssistantWorkflow failed; posting fallback to thread', {
      channelId: input.channelId,
      err: err instanceof Error ? err.message : String(err),
    });
    // Don't leave the user hanging. Best-effort: if even this post fails, let the
    // error surface so the run is recorded as failed.
    await postChannelReply({
      slackChannelId: input.slackChannelId,
      text: ":warning: Sorry, I hit an error working on that and couldn't finish. Please try again.",
      threadTs: input.threadTs,
    });
  }
}
