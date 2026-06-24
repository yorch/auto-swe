import { prisma } from '@auto-swe/shared/db';
import { currentYearMonth } from '@auto-swe/shared/lib/billing';
import type { ChannelAssistantTurnInput } from '@auto-swe/shared/types/workflow';
import {
  type ChannelMemoryItem,
  retrieveChannelMemory,
  writeChannelMemory,
} from '../lib/channelMemory.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import type { ModelBackedAgentKey } from '../lib/config/types.js';
import { postSlackThreadMessage } from '../lib/slackNotify.js';
import { runAgent } from './runAgent.js';

/** Fallback when a channel row has no explicit agent key (should never happen — the
 *  column defaults to this value — but be defensive). */
const DEFAULT_CHANNEL_AGENT_KEY = 'channelAssistant';

/** Friendly reply returned when a channel has hit its monthly assistant budget. */
const BUDGET_EXCEEDED_REPLY =
  ':moneybag: This channel has reached its monthly assistant budget. An admin can raise it in the dashboard.';

/** Cap on how many retrieved memory items are injected into the prompt. */
const MAX_MEMORY_CONTEXT_ITEMS = 5;

/** Minimum reply length (chars) worth persisting as channel memory. Below this,
 *  the reply is likely a trivial acknowledgement not worth remembering. */
const MIN_MEMORY_REPLY_LENGTH = 40;

/** Max chars persisted for the summary (reply) and rationale (user text). */
const MEMORY_SUMMARY_MAX_CHARS = 500;
const MEMORY_RATIONALE_MAX_CHARS = 500;

/**
 * Claude Tag (Phase 2). Prepend a compact context block built from retrieved
 * channel memory to the user's message, keeping the original text intact below
 * it. Pure (no I/O) so it's directly unit-testable. Returns `userText`
 * unchanged when there are no items.
 */
export function formatMemoryContext(items: ChannelMemoryItem[], userText: string): string {
  if (items.length === 0) {
    return userText;
  }
  const bullets = items
    .slice(0, MAX_MEMORY_CONTEXT_ITEMS)
    .map((item) => `- ${item.summary}`)
    .join('\n');
  return `Relevant context from this channel's memory:\n${bullets}\n\nUser: ${userText}`;
}

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
  // channels without a cap pay no extra query. NOTE: this is a SOFT cap. The
  // pre-turn read here and the post-turn `accrueChannelUsage` increment are not
  // transactional, so concurrent turns can each pass this check before any of
  // them records cost — briefly overshooting the cap. This mirrors the org-budget
  // soft-cap at work-request submit; a hard cap would need a transactional
  // reserve (out of scope).
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

  // Phase 2: retrieve channel-scoped memory similar to this message and prepend
  // it as context, so the assistant builds knowledge over time. Best-effort —
  // a retrieval failure (e.g. embedding round-trip) must not block the reply.
  let memory: ChannelMemoryItem[] = [];
  try {
    memory = await retrieveChannelMemory(input.userText, { channelId: input.channelId });
  } catch (err) {
    console.error(
      `[channelAssistant] failed to retrieve channel memory for ${input.channelId}:`,
      err instanceof Error ? err.message : err
    );
  }
  const userMessage = formatMemoryContext(memory, input.userText);

  const result = await runAgent(spec, userMessage, { spanName: 'llm.channel_assistant' });

  // Post-turn channel-scoped accrual. Best-effort: a failure here must NOT break
  // the reply — the workflow-level ledger (recordLlmUsage inside runAgent) is the
  // source of truth for billing; this row only backs the per-channel cap. We
  // accrue the authoritative `costUsd` returned by runAgent (priced by the agent
  // KEY's configured model) so the per-channel ledger prices identically to the
  // run-level ledger rather than re-deriving cost from the raw spec string.
  await accrueChannelUsage(input.channelId, result.costUsd ?? 0);

  const reply = (result.text ?? '').trim();

  // Phase 2: persist this exchange as channel-scoped memory so future turns can
  // retrieve it. Best-effort — a failure here must never break the reply. Only
  // write non-trivial replies (skip terse acknowledgements). Storing the raw
  // exchange (reply as summary, user text as rationale) is the Phase-2 baseline;
  // a summarizing pass over the exchange is a future refinement.
  if (reply.length > MIN_MEMORY_REPLY_LENGTH) {
    try {
      await writeChannelMemory({
        channelId: input.channelId,
        orgId: input.orgId,
        rationale: input.userText.slice(0, MEMORY_RATIONALE_MAX_CHARS),
        summary: reply.slice(0, MEMORY_SUMMARY_MAX_CHARS),
        teamId: input.teamId,
        userSlackId: input.userSlackId,
      });
    } catch (err) {
      console.error(
        `[channelAssistant] failed to write channel memory for ${input.channelId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return { reply: reply || "I wasn't able to come up with a response. Could you rephrase?" };
}

/**
 * Increment the channel's current-month usage row with one turn's USD cost and a
 * completed-run count. The `costUsd` is the authoritative per-turn cost returned
 * by {@link runAgent} (priced by `recordLlmUsage` against the agent KEY's
 * configured model), so this per-channel ledger prices identically to the
 * run-level ledger — no re-pricing here.
 *
 * Uses Prisma's `increment` upsert (race-safe across concurrent turns in the
 * same channel), mirroring the `OrgMonthlyUsage` accrual in `finalizeWorkflowRun`.
 * Wrapped in try/catch so a DB error degrades to "reply still sent".
 */
async function accrueChannelUsage(channelId: string, costUsd: number): Promise<void> {
  try {
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
