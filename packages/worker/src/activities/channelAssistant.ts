import { prisma } from '@auto-swe/shared/db';
import { currentYearMonth } from '@auto-swe/shared/lib/billing';
import { scanSkillContent } from '@auto-swe/shared/lib/skillScanner';
import type { ChannelAssistantTurnInput } from '@auto-swe/shared/types/workflow';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import {
  type ChannelMemoryItem,
  retrieveChannelMemory,
  writeChannelMemory,
} from '../lib/channelMemory.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import type { ModelBackedAgentKey } from '../lib/config/types.js';
import {
  postSlackThreadMessage,
  postSlackThreadMessageReturningTs,
  updateSlackMessage,
} from '../lib/slackNotify.js';
import { runAgent } from './runAgent.js';

/** Fallback when a channel row has no explicit agent key (should never happen — the
 *  column defaults to this value — but be defensive). */
const DEFAULT_CHANNEL_AGENT_KEY = 'channelAssistant';

/** Friendly reply returned when a channel has hit its monthly assistant budget. */
const BUDGET_EXCEEDED_REPLY =
  ':moneybag: This channel has reached its monthly assistant budget. An admin can raise it in the dashboard.';

/** Placeholder posted immediately so the user sees the teammate "working" while
 *  the LLM turn runs; later edited in place with the reply via chat.update. */
export const CHANNEL_PLACEHOLDER_TEXT = ':hourglass_flowing_sand: _Working on it…_';

/** Friendly text the placeholder is edited to (or posted as) when the turn errors. */
export const CHANNEL_ERROR_REPLY =
  ":warning: Sorry, I hit an error working on that and couldn't finish. Please try again.";

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
 * Shared pre-LLM budget gate for both the assistant turn and the ambient digest.
 * Returns `true` when the channel has a positive `monthlyBudgetUsdCents` cap and
 * the current month's accrued spend has reached it. When no cap is set, returns
 * `false` immediately without issuing the usage query (the no-cap fast path).
 *
 * Centralises the cap-set → `findUnique(ChannelMonthlyUsage)` → `Number(...)` →
 * `isChannelOverBudget` sequence so the assistant and ambient paths stay in
 * lockstep (same query, same predicate).
 */
export async function isChannelOverBudgetNow(
  channelId: string,
  monthlyBudgetUsdCents: number | null
): Promise<boolean> {
  if (monthlyBudgetUsdCents == null || monthlyBudgetUsdCents <= 0) {
    return false;
  }
  const usage = await prisma.channelMonthlyUsage.findUnique({
    select: { costUsdAccrued: true },
    where: {
      channelId_yearMonth: { channelId, yearMonth: currentYearMonth() },
    },
  });
  const accruedUsd = usage ? Number(usage.costUsdAccrued) : 0;
  return isChannelOverBudget(accruedUsd, monthlyBudgetUsdCents);
}

/**
 * Shared resolve-spec → `runAgent` core for both channel paths (the assistant
 * turn and the ambient digest). Resolves the channel's configured agent through
 * the Agent library with the CHANNEL config tier active (`ctx.channelId`, with
 * team/org cascading after), runs one generation against `userMessage`, and
 * returns the trimmed reply text plus the authoritative per-turn USD cost.
 *
 * Deliberately does NOT accrue channel usage — the two callers accrue at
 * different points (the assistant accrues after generate + before writing
 * memory; the ambient accrues before its should-post check), so each caller
 * owns its `accrueChannelUsage` call to preserve the existing ordering.
 */
export async function runChannelAgentTurn(
  channel: { id: string; agentKey: string; teamId: string; orgId: string },
  userMessage: string,
  spanName: string
): Promise<{ reply: string; costUsd: number }> {
  const agentKey = channel.agentKey || DEFAULT_CHANNEL_AGENT_KEY;

  // CHANNEL tier fires because `channelId` is set; team/org tiers cascade after it.
  const spec = await resolveAgentSpec(
    { agentKey: agentKey as ModelBackedAgentKey, basePrompt: '' },
    { channelId: channel.id, orgId: channel.orgId, teamId: channel.teamId }
  );

  const result = await runAgent(spec, userMessage, { spanName });

  return { costUsd: result.costUsd ?? 0, reply: (result.text ?? '').trim() };
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
  if (await isChannelOverBudgetNow(input.channelId, channel?.monthlyBudgetUsdCents ?? null)) {
    return { reply: BUDGET_EXCEEDED_REPLY };
  }

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

  // Phase 4: scan the ingested channel message — untrusted user input fed to the
  // LLM — for injection/exfiltration patterns. ADVISORY only (mirrors the
  // implementer's LLM-output scanner): warnings are recorded as a named security
  // event, but the turn always proceeds. Wrapped in try/catch so a scanner/DB
  // failure never aborts the turn. We scan only `input.userText`, not the
  // prepended memory context — that originated from prior, already-scanned input.
  await scanChannelInput(input);

  // Resolve the channel's agent (CHANNEL tier active) + run one generation.
  const { reply, costUsd } = await runChannelAgentTurn(
    { agentKey, id: input.channelId, orgId: input.orgId, teamId: input.teamId },
    userMessage,
    'llm.channel_assistant'
  );

  // Post-turn channel-scoped accrual. Best-effort: a failure here must NOT break
  // the reply — the workflow-level ledger (recordLlmUsage inside runAgent) is the
  // source of truth for billing; this row only backs the per-channel cap. We
  // accrue the authoritative `costUsd` returned by runAgent (priced by the agent
  // KEY's configured model) so the per-channel ledger prices identically to the
  // run-level ledger rather than re-deriving cost from the raw spec string.
  await accrueChannelUsage(input.channelId, costUsd);

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
export async function accrueChannelUsage(channelId: string, costUsd: number): Promise<void> {
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

/**
 * Claude Tag (Phase 4): advisory injection/exfiltration scan of the ingested
 * channel message. Channel content is untrusted input fed to the agent, so we
 * scan `input.userText` with the same {@link scanSkillContent} the implementer's
 * LLM-output scanner uses. NON-BLOCKING: if warnings are returned, we record a
 * named `channel.suspicious_input` advisory security event (via {@link AgentTracer}
 * → `activity_event`, mirroring `llm.suspicious_output`) and proceed. The whole
 * thing is wrapped in try/catch so a scanner/DB failure can never abort the turn.
 */
async function scanChannelInput(input: ChannelAssistantTurnInput): Promise<void> {
  try {
    const scan = await scanSkillContent(input.userText);
    if (!scan.safe) {
      const tracer = new AgentTracer();
      tracer.addActivityEvent({
        inputJson: { channelId: input.channelId, userSlackId: input.userSlackId },
        name: 'channel.suspicious_input',
        outputJson: { warnings: scan.warnings },
      });
      await persistActivityTrace(tracer, 'channelAssistant');
    }
  } catch {
    // Advisory scan failure is non-fatal — the turn continues without the check.
  }
}

/**
 * Claude Tag (Phase 4): post the "working on it" placeholder into the thread and
 * return its Slack `ts` so the workflow can edit it in place once the reply is
 * ready (live-progress UX). Returns `{ ts: null }` when the placeholder couldn't
 * be posted (no ts) — the workflow then falls back to a fresh reply message.
 */
export async function postChannelPlaceholder(args: {
  slackChannelId: string;
  threadTs: string;
}): Promise<{ ts: string | null }> {
  // `postSlackThreadMessageReturningTs` throws on a missing token or a missing
  // ts, so swallow any failure here and return `{ ts: null }` to honour the
  // documented contract — the workflow then falls back to a fresh reply post
  // without relying on its outer catch.
  try {
    const { ts } = await postSlackThreadMessageReturningTs(
      args.slackChannelId,
      args.threadTs,
      CHANNEL_PLACEHOLDER_TEXT
    );
    return { ts };
  } catch (err) {
    console.debug(
      `[channelAssistant] failed to post placeholder for ${args.slackChannelId}:`,
      err instanceof Error ? err.message : err
    );
    return { ts: null };
  }
}

/**
 * Claude Tag (Phase 4): edit a previously posted placeholder in place with the
 * final reply (or a friendly error) via Slack `chat.update`.
 */
export async function updateChannelReply(args: {
  slackChannelId: string;
  ts: string;
  text: string;
}): Promise<void> {
  await updateSlackMessage(args.slackChannelId, args.ts, args.text);
}
