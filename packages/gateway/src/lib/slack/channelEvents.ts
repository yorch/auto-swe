import type { ChannelAssistantTurnInput } from '@auto-swe/shared/types/workflow';
import type { FastifyInstance } from 'fastify';
import { provisionChannel, startChannelTurn } from './channelProvision.js';
import { isLiveThreadSession, trySteerThreadTask } from './threadSteering.js';
import type { SlackEventCallback, SlackEventInner, SlackInteractivePayload } from './types.js';

/** Strip Slack mention tokens (`<@U…>`, `<@U…|name>`) and collapse whitespace. */
export function stripMentions(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+(\|[^>]*)?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Auto-provision the channel and start the assistant workflow. Runs out-of-band
 * after the 200 ack, so it owns its errors (logged by the caller's `.catch`).
 */
export async function processChannelEvent(
  fastify: FastifyInstance,
  body: SlackEventCallback,
  event: SlackEventInner
): Promise<void> {
  const slackChannelId = event.channel;
  const eventTs = event.ts;
  if (!slackChannelId || !eventTs) {
    return;
  }

  const slackTeamId = event.team ?? body.team_id ?? body.authorizations?.[0]?.team_id;
  if (!slackTeamId) {
    fastify.log.warn({ event }, 'slack event missing workspace id — cannot provision channel');
    return;
  }

  const userText = stripMentions(event.text ?? '');
  const threadTs = event.thread_ts ?? eventTs;

  // Gap G: Slack tags private channels with `channel_type: 'group'` (public is
  // 'channel', DMs 'im'). Pass it as a best-effort default for a freshly
  // provisioned channel's `isPrivate` flag; admins can override afterwards.
  const channelRow = await provisionChannel(fastify, slackTeamId, slackChannelId, {
    isPrivate: event.channel_type === 'group',
  });
  if (!channelRow) {
    return;
  }

  // Signal-steering (Phase C): a reply inside a thread that already has an
  // in-flight task run STEERS that run instead of starting a fresh turn. A reply
  // is identified by `thread_ts` differing from this message's own `ts`. We try
  // the `steer` signal first — and only when it succeeds do we treat the event
  // as handled. A WorkflowNotFoundError (no active task run in this thread) is
  // benign: we fall through to normal handling below (a fresh mention → a turn;
  // a plain non-mention reply → ignored). Steering takes precedence over
  // launching a new turn in the same thread, so a thread reply that is ALSO an
  // app_mention still steers an active run.
  const isThreadReply = !!event.thread_ts && event.thread_ts !== eventTs;
  if (isThreadReply && event.thread_ts) {
    const steered = await trySteerThreadTask(
      fastify,
      channelRow.id,
      event.thread_ts,
      slackChannelId,
      userText,
      event.user
    );
    if (steered) {
      return;
    }
  }

  const isMention = event.type === 'app_mention';
  const isDm = event.type === 'message' && event.channel_type === 'im';
  // No active task run to steer. Plain (non-mention, non-DM) channel thread
  // replies normally do NOT start a turn — they only exist to attempt a steer.
  // EXCEPTION (Gap H — persistent live session): when the channel opts in
  // (`followupSessionEnabled`) and the assistant was recently active in THIS
  // thread, a plain follow-up reply continues the conversation without a
  // re-@mention. Otherwise drop it so arbitrary channel chatter never spawns a
  // workflow.
  // Gap H: true only for a re-mention-free continuation (a plain thread reply in
  // a live session). Drives the SKIP-aware intent gate in the turn so the
  // assistant stays out of human-to-human chatter.
  let isFollowup = false;
  if (!isMention && !isDm) {
    const continues =
      isThreadReply &&
      !!event.thread_ts &&
      channelRow.followupSessionEnabled &&
      (await isLiveThreadSession(fastify, channelRow.id, event.thread_ts));
    if (!continues) {
      return;
    }
    isFollowup = true;
    // Fall through to start a continuation turn (same path as a mention).
  }

  const input: ChannelAssistantTurnInput = {
    channelId: channelRow.id,
    followup: isFollowup,
    orgId: channelRow.orgId,
    slackChannelId,
    teamId: channelRow.teamId,
    threadTs,
    userSlackId: event.user ?? '',
    userText,
  };

  const started = await startChannelTurn(fastify, `chan-${channelRow.id}-${eventTs}`, input);
  if (!started) {
    fastify.log.info(
      { channelId: channelRow.id, eventTs },
      'channel-assistant workflow already started for this event — skipping redelivery'
    );
  }
}

/**
 * Message shortcut handler ("Ask auto-swe about this"). Provisions the channel
 * (like an @mention) and starts a channel-assistant turn seeded with the message
 * text, threaded under that message. Runs out-of-band after the interactivity ack;
 * owns its errors (logged by the caller's `.catch`).
 */
export async function handleAskMessageShortcut(
  fastify: FastifyInstance,
  payload: SlackInteractivePayload
): Promise<void> {
  const slackChannelId = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const slackTeamId = payload.team?.id;
  if (!slackChannelId || !messageTs || !slackTeamId) {
    fastify.log.warn(
      { callbackId: payload.callback_id },
      'ask message shortcut missing channel/message/team'
    );
    return;
  }

  // File/image-only messages carry no text — a turn seeded with an empty prompt
  // is useless, so skip rather than spawn a no-op workflow.
  const userText = stripMentions(payload.message?.text ?? '');
  if (!userText) {
    fastify.log.info(
      { messageTs, slackChannelId },
      'ask message shortcut on empty message — skipping'
    );
    return;
  }

  // Gap G: Slack private-channel ids are prefixed `G` (public `C`). Pass it as a
  // best-effort default for a freshly provisioned channel's `isPrivate` flag —
  // the shortcut payload lacks the `channel_type` the events path uses.
  const channelRow = await provisionChannel(fastify, slackTeamId, slackChannelId, {
    isPrivate: slackChannelId.startsWith('G'),
  });
  if (!channelRow) {
    return;
  }

  // Reply in the message's thread (or thread under it when it's a top-level message).
  const threadTs = payload.message?.thread_ts ?? messageTs;
  const input: ChannelAssistantTurnInput = {
    channelId: channelRow.id,
    followup: false,
    orgId: channelRow.orgId,
    slackChannelId,
    teamId: channelRow.teamId,
    threadTs,
    userSlackId: payload.user?.id ?? '',
    userText,
  };

  // Namespace with `-ask-` so the shortcut's per-message workflowId never
  // collides with the @mention path's `chan-<id>-<ts>` for the same message
  // ts — a collision would be swallowed as a duplicate and the click would go
  // unanswered. `startChannelTurn` keeps the double-click idempotent.
  await startChannelTurn(fastify, `chan-${channelRow.id}-ask-${messageTs}`, input);
}
