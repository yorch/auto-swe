import { prisma } from '@auto-swe/shared/db';
import { currentYearMonth } from '@auto-swe/shared/lib/billing';
import type { ChannelAssistantTurnInput } from '@auto-swe/shared/types/workflow';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import type { ModelBackedAgentKey } from '../lib/config/types.js';
import { calculateCostUsd } from '../lib/costTracking.js';
import { postSlackThreadMessage } from '../lib/slackNotify.js';
import { runAgent } from './runAgent.js';

/** Fallback when a channel row has no explicit agent key (should never happen — the
 *  column defaults to this value — but be defensive). */
const DEFAULT_CHANNEL_AGENT_KEY = 'channelAssistant';

/** Friendly reply returned when a channel has hit its monthly assistant budget. */
const BUDGET_EXCEEDED_REPLY =
  ':moneybag: This channel has reached its monthly assistant budget. An admin can raise it in the dashboard.';

/**
 * Pure budget predicate (extracted for unit-testing). A channel is over budget
 * when a cap is set and the month-to-date accrued spend (USD) meets or exceeds
 * it. The comparison is done in cents — `capCents` is an integer cent value and
 * `accruedUsd` is a USD amount — so we scale the USD side up rather than scaling
 * the cap down (avoids fractional-cent rounding letting a turn through).
 *
 * A `null`/`undefined` cap means "no cap" → never over budget. A non-positive
 * cap is treated as no cap (defensive; the admin UI shouldn't write one).
 */
export function isChannelOverBudget(
  accruedUsd: number,
  capCents: number | null | undefined
): boolean {
  if (capCents == null || capCents <= 0) {
    return false;
  }
  return accruedUsd * 100 >= capCents;
}

/**
 * Claude Tag (Phase 1). One conversational turn for a channel-resident Slack
 * assistant: load the channel's configured agent key, resolve it through the
 * Agent library with the CHANNEL config tier active (`ctx.channelId`), and
 * generate a reply to the user's message.
 *
 * Per-channel budget (Phase 1):
 *  - Pre-turn: if the channel has a `monthlyBudgetUsdCents` cap and the current
 *    month's accrued spend has reached it, skip the LLM call entirely and return
 *    a friendly "budget reached" reply. No further cost is accrued.
 *  - Post-turn: best-effort increment `ChannelMonthlyUsage` for the current
 *    month with this turn's USD cost + one completed run. A failure to record
 *    usage must never break the reply (wrapped in try/catch).
 *
 * Trace persistence + the workflow-level `recordLlmUsage` accounting are handled
 * inside {@link runAgent}; the channel-monthly accrual below is an independent,
 * channel-scoped ledger used purely for the per-channel cap.
 */
export async function runChannelAssistantTurn(
  input: ChannelAssistantTurnInput
): Promise<{ reply: string }> {
  const channel = await prisma.slackChannel.findUnique({
    select: { agentKey: true, monthlyBudgetUsdCents: true },
    where: { id: input.channelId },
  });
  const agentKey = channel?.agentKey || DEFAULT_CHANNEL_AGENT_KEY;

  // Pre-turn budget enforcement. Only read the accrued row when a cap is set —
  // channels without a cap pay no extra query.
  if (channel?.monthlyBudgetUsdCents != null && channel.monthlyBudgetUsdCents > 0) {
    const usage = await prisma.channelMonthlyUsage.findUnique({
      select: { costUsdAccrued: true },
      where: {
        channelId_yearMonth: { channelId: input.channelId, yearMonth: currentYearMonth() },
      },
    });
    const accruedUsd = usage ? Number(usage.costUsdAccrued) : 0;
    if (isChannelOverBudget(accruedUsd, channel.monthlyBudgetUsdCents)) {
      return { reply: BUDGET_EXCEEDED_REPLY };
    }
  }

  // CHANNEL tier fires because `channelId` is set; team/org tiers cascade after it.
  const spec = await resolveAgentSpec(
    { agentKey: agentKey as ModelBackedAgentKey, basePrompt: '' },
    { channelId: input.channelId, orgId: input.orgId, teamId: input.teamId }
  );

  const result = await runAgent(spec, input.userText, { spanName: 'llm.channel_assistant' });

  // Post-turn channel-scoped accrual. Best-effort: a failure here must NOT break
  // the reply — the workflow-level ledger (recordLlmUsage inside runAgent) is the
  // source of truth for billing; this row only backs the per-channel cap.
  await accrueChannelUsage(input.channelId, spec.modelSpec, result.usage);

  const reply = (result.text ?? '').trim();
  return { reply: reply || "I wasn't able to come up with a response. Could you rephrase?" };
}

/**
 * Increment the channel's current-month usage row with one turn's USD cost and a
 * completed-run count. The per-turn cost is derived from the provider-reported
 * token usage and the agent's resolved model spec via {@link calculateCostUsd} —
 * the same price table (`MODEL_PRICES`) that `recordLlmUsage` uses, so the two
 * ledgers price identically.
 *
 * Uses Prisma's `increment` upsert (race-safe across concurrent turns in the
 * same channel), mirroring the `OrgMonthlyUsage` accrual in `finalizeWorkflowRun`.
 * Wrapped in try/catch so a DB error degrades to "reply still sent".
 */
async function accrueChannelUsage(
  channelId: string,
  modelSpec: string,
  usage: { inputTokens?: number; outputTokens?: number } | undefined
): Promise<void> {
  try {
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const costUsd = calculateCostUsd(modelSpec, inputTokens, outputTokens);
    const yearMonth = currentYearMonth();
    await prisma.channelMonthlyUsage.upsert({
      create: { channelId, costUsdAccrued: costUsd, runsCompleted: 1, yearMonth },
      update: {
        costUsdAccrued: { increment: costUsd },
        runsCompleted: { increment: 1 },
      },
      where: { channelId_yearMonth: { channelId, yearMonth } },
    });
  } catch (err) {
    // Best-effort: never let a billing-ledger write failure break the reply.
    console.error(
      `[channelAssistant] failed to accrue channel usage for ${channelId}:`,
      err instanceof Error ? err.message : err
    );
  }
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
