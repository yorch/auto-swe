import { prisma } from '@auto-swe/shared/db';
import { currentYearMonth } from '@auto-swe/shared/lib/billing';
import {
  type RecentChannelMemoryItem,
  recentChannelMemory,
  writeChannelMemory,
} from '../lib/channelMemory.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import type { ModelBackedAgentKey } from '../lib/config/types.js';
import { postSlackChannelMessage } from '../lib/slackNotify.js';
import { accrueChannelUsage, isChannelOverBudget } from './channelAssistant.js';
import { runAgent } from './runAgent.js';

/** Input for the ambient digest activity (mirrors the workflow arg). */
export interface ChannelAmbientInput {
  channelId: string;
}

/** Fallback agent key when a channel row somehow lacks one (column has a default). */
const DEFAULT_CHANNEL_AGENT_KEY = 'channelAssistant';

/** Cap on how many recent memory items are injected into the digest prompt. */
const MAX_DIGEST_MEMORY_ITEMS = 15;

/** Sentinel the agent returns when nothing is worth posting (case-insensitive). */
const SKIP_SENTINEL = 'SKIP';

/** Below this length a "digest" is a trivial acknowledgement not worth posting. */
const MIN_DIGEST_LENGTH = 12;

/** Max chars persisted for the digest summary / rationale when remembering it. */
const MEMORY_SUMMARY_MAX_CHARS = 500;

/**
 * Build the ambient digest prompt from the channel's recent memory. Pure (no
 * I/O) so it's directly unit-testable. The agent is instructed to surface
 * forgotten / follow-up-worthy items and to reply with exactly `SKIP` when
 * nothing is worth posting.
 */
export function buildAmbientPrompt(items: RecentChannelMemoryItem[]): string {
  const bullets = items
    .slice(0, MAX_DIGEST_MEMORY_ITEMS)
    .map((item) => `- ${item.lessonSummary}`)
    .join('\n');
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
 * empty/whitespace reply, a too-trivial reply, or the `SKIP` sentinel (compared
 * case-insensitively after trimming) — keeping ambient mode noise-averse.
 */
export function shouldPostDigest(reply: string): boolean {
  const trimmed = reply.trim();
  if (trimmed.length < MIN_DIGEST_LENGTH) {
    return false;
  }
  if (trimmed.toLowerCase() === SKIP_SENTINEL.toLowerCase()) {
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

    // Budget gate. Only read the accrued row when a cap is set; over budget →
    // return quietly (no post, no spend). Mirrors the assistant turn's soft cap.
    if (channel.monthlyBudgetUsdCents != null && channel.monthlyBudgetUsdCents > 0) {
      const usage = await prisma.channelMonthlyUsage.findUnique({
        select: { costUsdAccrued: true },
        where: {
          channelId_yearMonth: { channelId: channel.id, yearMonth: currentYearMonth() },
        },
      });
      const accruedUsd = usage ? Number(usage.costUsdAccrued) : 0;
      if (isChannelOverBudget(accruedUsd, channel.monthlyBudgetUsdCents)) {
        return;
      }
    }

    // Nothing to digest → nothing to say.
    const memory = await recentChannelMemory(channel.id, MAX_DIGEST_MEMORY_ITEMS);
    if (memory.length === 0) {
      return;
    }

    const agentKey = channel.agentKey || DEFAULT_CHANNEL_AGENT_KEY;
    const spec = await resolveAgentSpec(
      { agentKey: agentKey as ModelBackedAgentKey, basePrompt: '' },
      { channelId: channel.id, orgId: channel.orgId, teamId: channel.teamId }
    );

    const result = await runAgent(spec, buildAmbientPrompt(memory), {
      spanName: 'llm.channel_ambient',
    });

    // Accrue the turn's cost regardless of whether we post (the LLM call happened).
    // Best-effort — accrueChannelUsage swallows its own failures.
    await accrueChannelUsage(channel.id, result.costUsd ?? 0);

    const reply = (result.text ?? '').trim();
    if (!shouldPostDigest(reply)) {
      return;
    }

    await postSlackChannelMessage(channel.slackChannelId, reply);

    // Best-effort: remember the digest so future turns/digests can build on it.
    try {
      await writeChannelMemory({
        channelId: channel.id,
        orgId: channel.orgId,
        rationale: 'ambient digest',
        summary: reply.slice(0, MEMORY_SUMMARY_MAX_CHARS),
        teamId: channel.teamId,
      });
    } catch (err) {
      console.error(
        `[channelAmbient] failed to remember digest for ${input.channelId}:`,
        err instanceof Error ? err.message : err
      );
    }
  } catch (err) {
    // Ambient must never throw loudly / spam: log and return.
    console.error(
      `[channelAmbient] digest failed for ${input.channelId}:`,
      err instanceof Error ? err.message : err
    );
  }
}
