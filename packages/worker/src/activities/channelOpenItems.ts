import { prisma } from '@auto-swe/shared/db';
import { CHANNEL_OPEN_ITEM_SWEEPER_PROMPT } from '@auto-swe/shared/lib/agentPrompts';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { recordLlmUsage } from '../lib/costTracking.js';
import { getModel } from '../lib/models.js';
import { fetchChannelHistory, postSlackChannelMessage } from '../lib/slackNotify.js';
import { accrueChannelUsage, isChannelOverBudgetNow } from './channelAssistant.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SweepChannelOpenItemsInput {
  channelId: string;
}

export interface SweepChannelOpenItemsResult {
  itemsCreated: number;
  itemsResolved: number;
  nudgesSent: number;
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const DetectedItemSchema = z.object({
  description: z.string(),
  ownerUserId: z.string().optional(),
  /** Slack message ts of the originating message, used as dedup anchor. */
  sourceTs: z.string().optional(),
});

const OpenItemSweepOutputSchema = z.object({
  /** New open items detected in the recent message window. */
  newItems: z.array(DetectedItemSchema),
  /** IDs of existing OPEN items that appear resolved in the recent messages. */
  resolvedIds: z.array(z.string()),
});

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_HISTORY_MESSAGES = 40;

/** Window of recent messages to scan for new items and resolutions. */
const SWEEP_LOOKBACK_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Age at which an unresolved open item becomes "stale" and warrants a nudge. */
const DEFAULT_NUDGE_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Minimum interval between nudges for the same item. */
const DEFAULT_NUDGE_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hours

/** Per-message char cap when building the transcript. */
const MAX_MESSAGE_CHARS = 400;

// ── Prompt ───────────────────────────────────────────────────────────────────

function buildSweepPrompt(
  transcript: string,
  existingItems: Array<{ id: string; description: string }>
): string {
  const existingBlock =
    existingItems.length > 0
      ? [
          '\nCurrently tracked OPEN items (check if any are now resolved):',
          ...existingItems.map((it) => `- [${it.id}] ${it.description}`),
        ].join('\n')
      : '\nNo open items currently tracked for this channel.';

  return [
    'Recent conversation (oldest first, format: `ts|user: text`):',
    transcript,
    existingBlock,
  ].join('\n');
}

// ── Activity ─────────────────────────────────────────────────────────────────

/**
 * Channel assistant (Gap C): sweep recent channel history to detect new open
 * items and follow up on stale ones.
 *
 * Called from `ChannelAmbientWorkflow` on each ambient fire (best-effort, like
 * Gap F `consolidateChannelMemory`). Three things happen per fire:
 *
 * 1. **Detect** — LLM reads recent messages and lists new open items not yet
 *    tracked, plus which existing OPEN items appear resolved.
 * 2. **Persist** — new items are inserted; resolved IDs are status-updated.
 *    `sourceTs` is used as a dedup anchor so the same message never spawns
 *    two items across consecutive fires.
 * 3. **Nudge** — for each still-OPEN item that is older than `DEFAULT_NUDGE_AFTER_MS`
 *    (or the channel's `openItemNudgeAfterHours` override) and hasn't been nudged
 *    in `DEFAULT_NUDGE_COOLDOWN_MS` (or `openItemNudgeCooldownHours`), the assistant posts a
 *    brief follow-up to the channel top-level.
 *
 * Budget-gated: over the cap ⇒ early return without LLM spend.
 * Never throws: any error is logged so a flaky sweep can't crash the schedule.
 */
export async function sweepChannelOpenItems(
  input: SweepChannelOpenItemsInput
): Promise<SweepChannelOpenItemsResult> {
  const emptyResult: SweepChannelOpenItemsResult = {
    itemsCreated: 0,
    itemsResolved: 0,
    nudgesSent: 0,
  };

  try {
    const channel = await prisma.slackChannel.findUnique({
      select: {
        agentKey: true,
        ambientEnabled: true,
        id: true,
        isActive: true,
        monthlyBudgetUsdCents: true,
        openItemNudgeAfterHours: true,
        openItemNudgeCooldownHours: true,
        orgId: true,
        slackChannelId: true,
        teamId: true,
      },
      where: { id: input.channelId },
    });

    if (!channel?.ambientEnabled || !channel.isActive) {
      return emptyResult;
    }

    const nudgeAfterMs =
      channel.openItemNudgeAfterHours != null
        ? channel.openItemNudgeAfterHours * 3_600_000
        : DEFAULT_NUDGE_AFTER_MS;
    const nudgeCooldownMs =
      channel.openItemNudgeCooldownHours != null
        ? channel.openItemNudgeCooldownHours * 3_600_000
        : DEFAULT_NUDGE_COOLDOWN_MS;

    if (await isChannelOverBudgetNow(channel.id, channel.monthlyBudgetUsdCents)) {
      return emptyResult;
    }

    // Fetch recent messages for detection window.
    const now = new Date();
    const lookbackFloor = new Date(now.getTime() - SWEEP_LOOKBACK_MS);

    const messages = await fetchChannelHistory(channel.slackChannelId, {
      limit: MAX_HISTORY_MESSAGES,
      oldestTs: (lookbackFloor.getTime() / 1000).toFixed(6),
    });

    // Fetch existing OPEN items and tracked source timestamps in parallel.
    const [existingOpen, trackedSourceTs] = await Promise.all([
      prisma.channelOpenItem.findMany({
        select: {
          createdAt: true,
          description: true,
          id: true,
          lastNudgedAt: true,
          ownerUserId: true,
        },
        where: { channelId: channel.id, status: 'OPEN' },
      }),
      prisma.channelOpenItem.findMany({
        select: { sourceTs: true },
        where: { channelId: channel.id, sourceTs: { not: null } },
      }),
    ]);
    const trackedTsSet = new Set(trackedSourceTs.map((r) => r.sourceTs).filter(Boolean));

    // If no messages and no existing open items, nothing to do.
    if (messages.length === 0 && existingOpen.length === 0) {
      return emptyResult;
    }

    // Build transcript (include bot messages so the LLM can see resolutions).
    const transcript = messages
      .filter((m) => m.text.trim().length > 0)
      .map((m) => {
        const who = m.isBot ? 'assistant' : m.user ? `<@${m.user}>` : 'user';
        return `${m.ts ?? ''}|${who}: ${m.text.trim().slice(0, MAX_MESSAGE_CHARS)}`;
      })
      .join('\n');

    // LLM call with structured output.
    const agent = new Agent({
      id: 'channel-open-item-sweeper',
      instructions: CHANNEL_OPEN_ITEM_SWEEPER_PROMPT,
      model: await getModel('commitToMemory'),
      name: 'channel-open-item-sweeper',
    });

    const tracer = new AgentTracer();
    let totalCostUsd = 0;

    try {
      const prompt = buildSweepPrompt(
        transcript,
        existingOpen.map((it) => ({ description: it.description, id: it.id }))
      );

      const start = Date.now();
      const result = await agent.generate([{ content: prompt, role: 'user' }], {
        structuredOutput: { schema: OpenItemSweepOutputSchema },
      });

      if (result.usage) {
        const attribution = await recordLlmUsage(
          'sweepChannelOpenItems',
          'commitToMemory',
          result.usage,
          'llm.channel_open_items_sweep'
        );
        totalCostUsd += attribution.costUsd;
        tracer.addLlmResponse({
          costUsd: attribution.costUsd,
          durationMs: Date.now() - start,
          inputJson: { systemPrompt: CHANNEL_OPEN_ITEM_SWEEPER_PROMPT, userMessage: prompt },
          inputTokens: attribution.inputTokens,
          model: attribution.modelSpec || undefined,
          outputJson: result.object ?? null,
          outputTokens: attribution.outputTokens,
          role: 'commitToMemory',
        });
      }

      if (!result.object) {
        return emptyResult;
      }

      const { newItems, resolvedIds } = OpenItemSweepOutputSchema.parse(result.object);

      // Deduplicate new items: by sourceTs when available, otherwise by
      // description against current OPEN items (items without a unique ts anchor
      // are deduped by content so the same task isn't re-created every sweep).
      const trackedDescriptionSet = new Set(existingOpen.map((it) => it.description));
      const freshItems = newItems.filter((it) => {
        if (it.sourceTs) {
          return !trackedTsSet.has(it.sourceTs);
        }
        return !trackedDescriptionSet.has(it.description);
      });

      // 1. Create new items in one batch.
      if (freshItems.length > 0) {
        await prisma.channelOpenItem.createMany({
          data: freshItems.map((it) => ({
            channelId: channel.id,
            description: it.description,
            ownerUserId: it.ownerUserId ?? null,
            sourceTs: it.sourceTs ?? null,
            status: 'OPEN' as const,
          })),
        });
      }
      const itemsCreated = freshItems.length;

      // 2. Mark resolved items.
      let itemsResolved = 0;
      if (resolvedIds.length > 0) {
        const validIdSet = new Set(existingOpen.map((it) => it.id));
        const toResolve = resolvedIds.filter((id) => validIdSet.has(id));
        if (toResolve.length > 0) {
          await prisma.channelOpenItem.updateMany({
            data: { status: 'RESOLVED' as const },
            where: { id: { in: toResolve }, status: 'OPEN' },
          });
          itemsResolved = toResolve.length;
        }
      }

      // 3. Nudge stale OPEN items (outside the just-resolved set).
      const resolvedSet = new Set(resolvedIds);
      const staleItems = existingOpen.filter((it) => {
        if (resolvedSet.has(it.id)) {
          return false;
        }
        const age = now.getTime() - it.createdAt.getTime();
        if (age < nudgeAfterMs) {
          return false;
        }
        const sinceNudge = it.lastNudgedAt
          ? now.getTime() - it.lastNudgedAt.getTime()
          : Number.POSITIVE_INFINITY;
        return sinceNudge >= nudgeCooldownMs;
      });

      let nudgesSent = 0;
      for (const item of staleItems) {
        const mention = item.ownerUserId ? `<@${item.ownerUserId}> ` : '';
        const nudge = `${mention}Just checking in — any update on: _${item.description}_?`;
        try {
          // Write the cooldown timestamp BEFORE posting (at-most-once): a
          // transient Slack failure after this write can't cause a duplicate nudge.
          await prisma.channelOpenItem.update({
            data: { lastNudgedAt: now },
            where: { id: item.id },
          });
          await postSlackChannelMessage(channel.slackChannelId, nudge);
          nudgesSent++;
        } catch (err) {
          console.error(
            `[channelOpenItems] nudge failed for item ${item.id}:`,
            err instanceof Error ? err.message : err
          );
        }
      }

      const sweepResult: SweepChannelOpenItemsResult = { itemsCreated, itemsResolved, nudgesSent };
      tracer.addActivityEvent({ name: 'channel.open_items_sweep', outputJson: sweepResult });

      return sweepResult;
    } finally {
      await persistActivityTrace(tracer, 'commitToMemory');
      if (totalCostUsd > 0) {
        await accrueChannelUsage(channel.id, totalCostUsd, { countRun: false });
      }
    }
  } catch (err) {
    console.error(
      `[channelOpenItems] sweep failed for ${input.channelId}:`,
      err instanceof Error ? err.message : err
    );
    return emptyResult;
  }
}
