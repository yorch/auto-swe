import { prisma } from '@auto-swe/shared/db';
import type { ChannelAssistantTurnInput } from '@auto-swe/shared/types/workflow';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import type { ModelBackedAgentKey } from '../lib/config/types.js';
import { postSlackThreadMessage } from '../lib/slackNotify.js';
import { runAgent } from './runAgent.js';

/** Fallback when a channel row has no explicit agent key (should never happen — the
 *  column defaults to this value — but be defensive). */
const DEFAULT_CHANNEL_AGENT_KEY = 'channelAssistant';

/**
 * Claude Tag (Phase 0). One conversational turn for a channel-resident Slack
 * assistant: load the channel's configured agent key, resolve it through the
 * Agent library with the CHANNEL config tier active (`ctx.channelId`), and
 * generate a reply to the user's message.
 *
 * Cost tracking + trace persistence are handled inside {@link runAgent}
 * (`recordLlmUsage` + `persistActivityTrace`), so this activity is a thin
 * resolve-then-run wrapper. The trace's `nodeId`/`attempt` resolve to this
 * activity via Temporal context.
 */
export async function runChannelAssistantTurn(
  input: ChannelAssistantTurnInput
): Promise<{ reply: string }> {
  const channel = await prisma.slackChannel.findUnique({
    select: { agentKey: true },
    where: { id: input.channelId },
  });
  const agentKey = channel?.agentKey || DEFAULT_CHANNEL_AGENT_KEY;

  // CHANNEL tier fires because `channelId` is set; team/org tiers cascade after it.
  const spec = await resolveAgentSpec(
    { agentKey: agentKey as ModelBackedAgentKey, basePrompt: '' },
    { channelId: input.channelId, orgId: input.orgId, teamId: input.teamId }
  );

  const result = await runAgent(spec, input.userText, { spanName: 'llm.channel_assistant' });

  const reply = (result.text ?? '').trim();
  return { reply: reply || "I wasn't able to come up with a response. Could you rephrase?" };
}

/**
 * Post the assistant's reply back into the originating Slack thread. Delegates
 * to the shared {@link postSlackThreadMessage} helper (resolves the bot token
 * via `resolveSlackConfig`, never `process.env`).
 */
export async function postChannelReply(args: {
  slackChannelId: string;
  threadTs: string;
  text: string;
}): Promise<void> {
  await postSlackThreadMessage(args.slackChannelId, args.threadTs, args.text);
}
