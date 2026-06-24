import { prisma } from '@auto-swe/shared/db';
import { type RecentChannelMemoryItem, recentChannelMemory } from '../lib/channelMemory.js';
import { postSlackChannelMessage } from '../lib/slackNotify.js';
import {
  accrueChannelUsage,
  isChannelOverBudgetNow,
  runChannelAgentTurn,
} from './channelAssistant.js';

/** Input for the ambient digest activity (mirrors the workflow arg). */
export interface ChannelAmbientInput {
  channelId: string;
}

/** Fallback agent key when a channel row somehow lacks one (column has a default). */
const DEFAULT_CHANNEL_AGENT_KEY = 'channelAssistant';

/** Cap on how many recent memory items are injected into the digest prompt. */
const MAX_DIGEST_MEMORY_ITEMS = 15;

/**
 * Matches a reply that begins with the word `skip` (case-insensitive, after
 * trimming) — e.g. `SKIP`, `skip`, or a decorated `SKIP - nothing actionable`.
 * Any such reply is treated as the skip sentinel and is NOT posted.
 */
const SKIP_SENTINEL = /^skip\b/i;

/** Below this length a "digest" is a trivial acknowledgement not worth posting. */
const MIN_DIGEST_LENGTH = 12;

/**
 * Build the ambient digest prompt from the channel's recent memory. Pure (no
 * I/O) so it's directly unit-testable. The agent is instructed to surface
 * forgotten / follow-up-worthy items and to reply with exactly `SKIP` when
 * nothing is worth posting.
 */
export function buildAmbientPrompt(items: RecentChannelMemoryItem[]): string {
  // The item cap is enforced authoritatively at the fetch (`recentChannelMemory`
  // is called with MAX_DIGEST_MEMORY_ITEMS), so no re-slice is needed here.
  const bullets = items.map((item) => `- ${item.lessonSummary}`).join('\n');
  return [
    "You are this Slack channel's resident teammate posting a proactive, top-level",
    'update (not a reply to anyone). Below is recent context this channel has',
    'discussed or learned. Write a brief, friendly digest that surfaces items worth',
    'a follow-up or that may have been forgotten — open questions, loose ends,',
    'unresolved decisions. Keep it short (a few lines at most) and skip anything',
    'already resolved or not actionable.',
    '',
    'If nothing here is worth posting right now, reply with exactly: SKIP',
    '',
    "Recent context from this channel's memory:",
    bullets,
  ].join('\n');
}

/**
 * Decide whether a generated digest should be posted. Returns `false` for an
 * empty/whitespace reply, a too-trivial reply, or any reply whose trimmed text
 * begins with the `skip` sentinel word (e.g. `SKIP - nothing actionable today.`)
 * — keeping ambient mode noise-averse.
 */
export function shouldPostDigest(reply: string): boolean {
  const trimmed = reply.trim();
  if (trimmed.length < MIN_DIGEST_LENGTH) {
    return false;
  }
  if (SKIP_SENTINEL.test(trimmed)) {
    return false;
  }
  return true;
}

/**
 * Claude Tag (Phase 3) — ambient digest. Started by the per-channel Temporal
 * Schedule (managed by the gateway) on the channel's `ambientCron`, via the
 * {@link ChannelAmbientWorkflow}. Proactively posts a short, top-level digest to
 * the channel surfacing recent / forgotten items from its memory.
 *
 * Noise-averse + budget-gated + best-effort:
 *  - No-op if the channel is disabled/inactive (stale schedule) or has nothing
 *    to work with.
 *  - Skips the LLM call entirely when the channel is over its monthly budget
 *    (no post, no spend).
 *  - Skips the post when the agent returns `SKIP` / an empty / trivial reply.
 *  - Never throws: any failure is logged and swallowed so a flaky digest can't
 *    spam the channel or crash the schedule.
 */
export async function runChannelAmbientDigest(input: ChannelAmbientInput): Promise<void> {
  try {
    const channel = await prisma.slackChannel.findUnique({
      select: {
        agentKey: true,
        ambientEnabled: true,
        id: true,
        isActive: true,
        monthlyBudgetUsdCents: true,
        orgId: true,
        slackChannelId: true,
        teamId: true,
      },
      where: { id: input.channelId },
    });

    // Channel gone, or the schedule is stale (ambient turned off / archived).
    if (!channel?.ambientEnabled || !channel.isActive) {
      return;
    }

    // Budget gate. Over budget → return quietly (no post, no spend). Shares the
    // same pre-LLM gate as the assistant turn (no cap ⇒ no query, never over).
    if (await isChannelOverBudgetNow(channel.id, channel.monthlyBudgetUsdCents)) {
      return;
    }

    // Nothing to digest → nothing to say.
    const memory = await recentChannelMemory(channel.id, MAX_DIGEST_MEMORY_ITEMS);
    if (memory.length === 0) {
      return;
    }

    const agentKey = channel.agentKey || DEFAULT_CHANNEL_AGENT_KEY;
    const { reply, costUsd } = await runChannelAgentTurn(
      { agentKey, id: channel.id, orgId: channel.orgId, teamId: channel.teamId },
      buildAmbientPrompt(memory),
      'llm.channel_ambient'
    );

    // Accrue the turn's cost regardless of whether we post (the LLM call happened).
    // Best-effort — accrueChannelUsage swallows its own failures.
    await accrueChannelUsage(channel.id, costUsd);

    if (!shouldPostDigest(reply)) {
      return;
    }

    await postSlackChannelMessage(channel.slackChannelId, reply);

    // NOTE: deliberately do NOT persist the digest to channel memory. The digest
    // prompt is built from `recentChannelMemory`, so remembering our own
    // proactive output would feed each scheduled digest its prior digests —
    // compounding noise + token cost. Channel memory accrues from real
    // assistant turns only.
  } catch (err) {
    // Ambient must never throw loudly / spam: log and return.
    console.error(
      `[channelAmbient] digest failed for ${input.channelId}:`,
      err instanceof Error ? err.message : err
    );
  }
}
