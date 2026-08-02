import { prisma } from '@auto-swe/shared/db';
import { CHANNEL_MEMORY_SUMMARIZER_PROMPT } from '@auto-swe/shared/lib/agentPrompts';
import { currentYearMonth } from '@auto-swe/shared/lib/billing';
import { releaseChannelBudgetHolds } from '@auto-swe/shared/lib/channelBudget';
import { scanSkillContent } from '@auto-swe/shared/lib/skillScanner';
import type { ChannelAssistantTurnInput } from '@auto-swe/shared/types/workflow';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import {
  type ChannelMemoryItem,
  retrieveChannelMemory,
  writeChannelMemory,
} from '../lib/channelMemory.js';
import { applyPersona, resolvePersonaPrompt } from '../lib/channelPersona.js';
import {
  DELEGATE_TOOL_PROMPT_NOTE,
  FOLLOWUP_INTENT_PROMPT_NOTE,
  GENERATE_WORKFLOW_TOOL_PROMPT_NOTE,
  REFINE_WORKFLOW_TOOL_PROMPT_NOTE,
} from '../lib/channelTurnPrompts.js';
import { resolveAgent } from '../lib/config/agentResolver.js';
import type { AgentTools } from '../lib/config/agentSpec.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import type { ModelBackedAgentKey } from '../lib/config/types.js';
import { calculateCostUsd } from '../lib/costTracking.js';
import {
  fetchThreadReplies,
  postSlackThreadMessage,
  postSlackThreadMessageReturningTs,
  type SlackThreadMessage,
  updateSlackMessage,
} from '../lib/slackNotify.js';
import { SKIP_SENTINEL } from './channelConstants.js';
import { runAgent } from './runAgent.js';

/** Fallback when a channel row has no explicit agent key (should never happen — the
 *  column defaults to this value — but be defensive). */
export const DEFAULT_CHANNEL_AGENT_KEY = 'channelAssistant';

/** Friendly reply returned when a channel has hit its monthly assistant budget. */
const BUDGET_EXCEEDED_REPLY =
  ':moneybag: This channel has reached its monthly assistant budget. An admin can raise it in the dashboard.';

/** Placeholder posted immediately so the user sees the teammate "working" while
 *  the LLM turn runs; later edited in place with the reply via chat.update. */
export const CHANNEL_PLACEHOLDER_TEXT = ':hourglass_flowing_sand: _Working on it…_';

/** Friendly text the placeholder is edited to (or posted as) when the turn errors. */
export const CHANNEL_ERROR_REPLY =
  ":warning: Sorry, I hit an error working on that and couldn't finish. Please try again.";

/**
 * Channel assistant (Phase A): a captured "launch a durable task" intent. When
 * the agent decides a mention is a multi-step *task* (not a quick answer) it
 * calls the `delegateTask` tool; we capture the structured intent here and the
 * workflow launches a thread-bound `RunnableWorkflow` run from it. `route`
 * distinguishes a general agentic task from a code/PR task — Phase A only acts
 * on `'general'` downstream (Phase B wires `'code'`), but both are captured.
 */
export interface DelegateIntent {
  route: 'general' | 'code';
  title: string;
  description: string;
  /**
   * Channel assistant (Phase B): the repository the user named, if any. Only
   * meaningful for `route: 'code'` — the code-route launch resolves it (by
   * `repoName` or `organizationName/repoName`) against the channel team's active
   * `git_repo` connections; an unset/unmatched hint falls back to the team's sole
   * repo (if exactly one) or the general task route.
   */
  repoHint?: string;
  /**
   * Gap D: ISO 8601 timestamp at which to run the task. When set, the workflow
   * starts a `ChannelScheduledTaskWorkflow` that sleeps until this time before
   * launching the actual `RunnableWorkflow`. Leave unset for immediate execution.
   */
  runAt?: string;
}

/** Schema for the `delegateTask` tool's structured input (validated by Mastra). */
const DelegateTaskInputSchema = z.object({
  description: z.string().describe('A clear, self-contained description of the task to carry out.'),
  repoHint: z
    .string()
    .optional()
    .describe(
      'For a code task: the repository the user named, if any (e.g. "payments-api" ' +
        'or "acme/payments-api"). Leave unset if no repo was named.'
    ),
  route: z
    .enum(['general', 'code'])
    .describe(
      "'general' for a multi-step research/ops/writing task; 'code' for a task " +
        'that requires editing a repository and opening a pull request.'
    ),
  runAt: z
    .string()
    .optional()
    .describe(
      'ISO 8601 UTC timestamp (e.g. "2026-06-26T09:00:00Z") at which the task should ' +
        'run. Only set this when the user explicitly asks to defer the task to a specific ' +
        'future time. Leave unset for immediate execution.'
    ),
  title: z.string().describe('A short title for the task (a few words).'),
});

/** Structured output the agent sees back after delegating. */
const DelegateTaskOutputSchema = z.object({
  note: z.string(),
  queued: z.boolean(),
});

/**
 * Build the `delegateTask` Mastra tool. Calling it RECORDS the structured intent
 * into `onDelegate` (a closure the activity owns) and returns a short
 * confirmation — the actual run launch happens in the workflow after the turn.
 * The tool is intentionally side-effect-free here (no DB / no Temporal): the
 * activity must stay a pure "decide + reply" step; launching is the workflow's job.
 */
function buildDelegateTool(onDelegate: (intent: DelegateIntent) => void) {
  return createTool({
    description:
      'Launch a durable background task that will work on this request and ' +
      'report its result back in this Slack thread. Use for genuine multi-step ' +
      'work, not quick questions.',
    execute: async ({ description, repoHint, route, runAt, title }) => {
      onDelegate({ description, repoHint, route, runAt, title });
      return {
        note: 'Task queued — I will follow up in this thread when it is done.',
        queued: true,
      };
    },
    id: 'delegateTask',
    inputSchema: DelegateTaskInputSchema,
    outputSchema: DelegateTaskOutputSchema,
  });
}

/**
 * Channel assistant: a captured "build me a workflow" intent. When the agent
 * decides the user is asking to CREATE a reusable workflow/automation (not run a
 * one-off task) it calls the `generateWorkflow` tool; we capture the structured
 * intent here and the workflow generates + persists a DRAFT template after the turn.
 */
export interface GenerateWorkflowIntent {
  /** Plain-language description of the workflow to build. */
  description: string;
  /** Optional name for the generated template. */
  name?: string;
}

const GenerateWorkflowInputSchema = z.object({
  description: z
    .string()
    .describe('A clear, self-contained description of the workflow/automation to build.'),
  name: z.string().optional().describe('Optional short name for the workflow.'),
});

const GenerateWorkflowOutputSchema = z.object({
  note: z.string(),
  queued: z.boolean(),
});

/**
 * Build the `generateWorkflow` Mastra tool. Like `delegateTask` it only RECORDS
 * the intent (into `onGenerate`); the workflow does the generation + persistence
 * after the turn, keeping this activity a pure "decide + reply" step.
 */
function buildGenerateWorkflowTool(onGenerate: (intent: GenerateWorkflowIntent) => void) {
  return createTool({
    description:
      'Generate a reusable workflow (saved as a DRAFT template) from a ' +
      'natural-language description. Use when the user wants to create or set up an ' +
      'automation/pipeline, not run a one-off task.',
    execute: async ({ description, name }) => {
      onGenerate({ description, name });
      return {
        note: 'Workflow drafted — review and activate it in the Workflow library.',
        queued: true,
      };
    },
    id: 'generateWorkflow',
    inputSchema: GenerateWorkflowInputSchema,
    outputSchema: GenerateWorkflowOutputSchema,
  });
}

export interface RefineWorkflowIntent {
  /** Plain-language change to apply to the thread's current draft. */
  instruction: string;
}

const RefineWorkflowInputSchema = z.object({
  instruction: z
    .string()
    .describe('The change to apply to the workflow drafted earlier in this thread.'),
});

/**
 * Build the `refineWorkflow` Mastra tool. Like `generateWorkflow` it only RECORDS
 * the intent; the workflow resolves the thread's current draft and applies the
 * change after the turn.
 */
function buildRefineWorkflowTool(onRefine: (intent: RefineWorkflowIntent) => void) {
  return createTool({
    description:
      'Refine the workflow drafted earlier in this thread by describing a change. ' +
      'Use for a follow-up adjustment, not to create a new workflow.',
    execute: async ({ instruction }) => {
      onRefine({ instruction });
      return {
        note: 'Refinement queued — a new draft version will be saved.',
        queued: true,
      };
    },
    id: 'refineWorkflow',
    inputSchema: RefineWorkflowInputSchema,
    outputSchema: GenerateWorkflowOutputSchema,
  });
}

/** Cap on how many retrieved memory items are injected into the prompt. */
const MAX_MEMORY_CONTEXT_ITEMS = 5;

/** Cap on how many recent thread messages are injected as conversational context. */
const MAX_THREAD_CONTEXT_MESSAGES = 15;

/** Max chars kept per injected thread message (defensive against a huge paste). */
const MAX_THREAD_MESSAGE_CHARS = 500;

/** Minimum reply length (chars) worth persisting as channel memory. Below this,
 *  the reply is likely a trivial acknowledgement not worth remembering. */
const MIN_MEMORY_REPLY_LENGTH = 40;

/** Max chars persisted for the summary (reply) and rationale (user text). */
const MEMORY_SUMMARY_MAX_CHARS = 500;
const MEMORY_RATIONALE_MAX_CHARS = 500;

/**
 * Structured output for the channel-memory summarizer pass. We distill the
 * (userText, reply) exchange into a durable fact + why it matters, rather than
 * storing the raw transcript. Mirrors the `commitToMemory` lesson shape
 * (`lessonSummary` + `rationale`) so channel memory reads like SWE lessons.
 */
const ChannelMemorySummarySchema = z.object({
  lessonSummary: z.string(),
  rationale: z.string(),
});

/**
 * Channel assistant (Phase 2). Prepend a compact context block built from retrieved
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
    .map((item) =>
      item.crossChannel ? `- [from another channel] ${item.summary}` : `- ${item.summary}`
    )
    .join('\n');
  return `Relevant context from this channel's memory:\n${bullets}\n\nUser: ${userText}`;
}

/**
 * Pure (no I/O) — render the most recent thread messages as a compact transcript
 * to inject above the user's message, so the assistant has the conversation it is
 * replying inside (not just channel memory). Returns `userText` unchanged when
 * there are no thread messages.
 *
 * Caps to the LAST {@link MAX_THREAD_CONTEXT_MESSAGES} messages (most recent
 * context wins) and truncates each line to {@link MAX_THREAD_MESSAGE_CHARS}.
 * Messages with no text (e.g. a file-only post) are dropped. The bot's own past
 * messages are kept — they are valid context for a follow-up.
 */
export function formatThreadContext(messages: SlackThreadMessage[], userText: string): string {
  const lines = messages
    .filter((m) => m.text.trim().length > 0)
    .slice(-MAX_THREAD_CONTEXT_MESSAGES)
    .map((m) => {
      const who = m.user ? `<@${m.user}>` : 'someone';
      const text = m.text.trim().slice(0, MAX_THREAD_MESSAGE_CHARS);
      return `${who}: ${text}`;
    });
  if (lines.length === 0) {
    return userText;
  }
  return `Conversation so far in this thread (oldest first):\n${lines.join('\n')}\n\n${userText}`;
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

/** This month's accrued total for a channel, or 0 when it has spent nothing. */
async function accruedThisMonth(channelId: string, yearMonth: string): Promise<number> {
  const usage = await prisma.channelMonthlyUsage.findUnique({
    select: { costUsdAccrued: true },
    where: { channelId_yearMonth: { channelId, yearMonth } },
  });
  return usage ? Number(usage.costUsdAccrued) : 0;
}

/**
 * Budget gate: has this channel already reached its cap?
 *
 * Two callers, for two reasons. {@link isChannelOverBudgetForTask} gates a
 * delegated task run, whose spend lands on the run's own ledger when it
 * finalizes — there is nothing in-flight to hold. Every path that spends on the
 * channel ledger calls this first only as a cheap bail, to skip prompt-building
 * work when the answer is already no; the cap itself is enforced by
 * {@link reserveChannelTurn}, which holds for the duration of the call.
 *
 * **A refusal sweeps first.** The accrued total includes outstanding holds, so a
 * channel pushed over its cap by holds that a dead worker abandoned would refuse
 * every subsequent turn — including the ones that would otherwise have swept
 * those holds, since every caller bails here before reserving. That is the state
 * the sweep exists to fix, so it has to be reachable from inside it. The extra
 * round-trips are paid only on the path that was about to say no.
 */
export async function isChannelOverBudgetNow(
  channelId: string,
  monthlyBudgetUsdCents: number | null
): Promise<boolean> {
  if (monthlyBudgetUsdCents == null || monthlyBudgetUsdCents <= 0) {
    return false;
  }
  const yearMonth = currentYearMonth();
  if (!isChannelOverBudget(await accruedThisMonth(channelId, yearMonth), monthlyBudgetUsdCents)) {
    return false;
  }
  // A sweep that reclaimed nothing cannot have changed the answer, and refusal
  // is the *steady* state for a channel that has genuinely spent its budget —
  // re-reading on every event for the rest of the month would be pure waste.
  if ((await sweepExpiredHolds(channelId)) === 0) {
    return true;
  }
  return isChannelOverBudget(await accruedThisMonth(channelId, yearMonth), monthlyBudgetUsdCents);
}

/**
 * Fallback hold for one model call when the bound model has no known price.
 *
 * Everything else derives the hold from `MODEL_PRICES` — see
 * {@link estimateHoldUsd} — because one flat number is wrong by ~5x in one
 * direction or the other across the models a channel can be configured with.
 */
export const CHANNEL_TURN_RESERVATION_USD = 0.05;

/**
 * The token envelope a channel turn is held against.
 *
 * Still an estimate: the hold's job is to stop a stampede, and it is netted out
 * against the true cost the moment the turn settles. But the *price* half of
 * that estimate is something the system knows, so it is looked up rather than
 * guessed — a channel on Opus and a channel on Haiku differ by 5x per token.
 */
const HOLD_INPUT_TOKENS = 8_000;
const HOLD_OUTPUT_TOKENS = 1_500;

/**
 * How long a hold survives unsettled before a later reserve sweeps it.
 *
 * The window bounds what a worker that dies mid-turn costs the channel. It has
 * to clear the slowest held pass — consolidation fans out over a batch of
 * clusters — so it is generous; the cost of being generous is only that a lost
 * hold sits on the ledger a while longer.
 */
export const CHANNEL_HOLD_TTL_MS = 30 * 60_000;

/** What one turn against `agentKey` is expected to cost, in USD. */
async function estimateHoldUsd(
  agentKey: string,
  ctx: { channelId: string; orgId: string; teamId: string },
  modelCalls: number
): Promise<number> {
  let perCall = 0;
  try {
    const resolved = await resolveAgent(agentKey, ctx);
    // Through the ledger's own pricing helper, so the USD-per-MTok convention
    // lives in exactly one place — a hold sized by a second copy of the formula
    // would drift from the cost it is netted against.
    perCall = calculateCostUsd(resolved.model.spec, HOLD_INPUT_TOKENS, HOLD_OUTPUT_TOKENS);
  } catch {
    // Resolution failed (missing row, decrypt failure). The turn itself will
    // fail on the same lookup a moment later; hold the fallback rather than
    // letting an unpriced turn through unbounded.
  }
  // An unknown or zero-priced model prices at 0, and a zero hold bounds nothing.
  // The `* calls` scaling is applied once: forgetting it on any one branch would
  // under-hold a fan-out pass by exactly the factor `modelCalls` exists to cover.
  return (perCall > 0 ? perCall : CHANNEL_TURN_RESERVATION_USD) * Math.max(1, modelCalls);
}

/** A turn's claim on the channel's remaining monthly budget. */
export interface ChannelBudgetHold {
  /** The channel was already at its cap. Nothing is held; do not spend. */
  overBudget: boolean;
  /**
   * Replaces the hold with the turn's real cost. Idempotent, so a caller can
   * settle on its success path and still release in a `finally`.
   */
  settle(costUsd: number, opts?: { countRun?: boolean }): Promise<void>;
}

/**
 * Returns any expired holds' amounts to the ledger.
 *
 * A hold is an increment plus a row. The increment is what bounds concurrency;
 * the row is what makes it reversible. A worker that dies between reserving and
 * settling leaves both behind, and without this the increment would sit on the
 * channel's ledger for the rest of the calendar month — a deploy during a busy
 * hour would silence the channel until an admin reset its budget by hand.
 *
 * The refund protocol itself lives in `@auto-swe/shared/lib/channelBudget`,
 * because the gateway's admin reset performs the same one — and when the two
 * had a copy each they had already diverged on which month to credit.
 *
 * Returns how many holds were actually reclaimed, so a caller can skip the
 * re-read when a sweep changed nothing.
 */
async function sweepExpiredHolds(channelId: string): Promise<number> {
  const { released } = await releaseChannelBudgetHolds(prisma, channelId, { expiredOnly: true });
  return released;
}

/**
 * Claims budget for one turn, before the turn runs.
 *
 * A plain read-then-spend gate does not bound anything here: turn workflow ids
 * are per-event, so a busy channel runs many turns at once and every one of them
 * reads the same not-yet-incremented total and passes. The overshoot is bounded
 * by concurrency, which nothing bounds.
 *
 * So the gate writes. Each turn atomically increments the accrued total by its
 * estimated cost and decides on the value *before* its own increment, which
 * makes the headroom a resource turns consume rather than a number they all
 * read: with `H` USD of headroom left, at most `H / estimate` turns can be in
 * flight, whatever the concurrency. {@link ChannelBudgetHold.settle} then swaps
 * the hold for the real cost.
 *
 * The increment is paired with a `ChannelBudgetHold` row in the same
 * transaction, so an abandoned claim expires instead of persisting — see
 * {@link sweepExpiredHolds}.
 *
 * No cap set means no hold and no extra round-trip — `settle` is then just the
 * post-turn accrual those channels already did.
 */
export async function reserveChannelTurn(
  channelId: string,
  monthlyBudgetUsdCents: number | null,
  opts: {
    /** Agent whose bound model prices the hold. */
    agentKey: string;
    orgId: string;
    teamId: string;
    /**
     * How many model calls this hold covers. A single turn is one; the
     * background passes that fan out over a batch pass their batch size, so the
     * hold scales with what the pass will actually spend instead of
     * under-holding by the fan-out factor.
     */
    modelCalls?: number;
  }
): Promise<ChannelBudgetHold> {
  // Pin the month at reserve time. `currentYearMonth()` re-read at settle would
  // land the two halves on different rows across a UTC month boundary: the hold
  // would leak on the old row and the release would create the new one at a
  // negative balance.
  const yearMonth = currentYearMonth();
  if (monthlyBudgetUsdCents == null || monthlyBudgetUsdCents <= 0) {
    return makeHold(channelId, yearMonth, 0, null);
  }

  const reservation = await estimateHoldUsd(
    opts.agentKey,
    { channelId, orgId: opts.orgId, teamId: opts.teamId },
    opts.modelCalls ?? 1
  );

  let claim: { accruedBefore: number; holdId: string } | null = null;
  try {
    // Interactive rather than batched. The two statements are independent, so
    // `$transaction([a, b])` would save round-trips — but it evaluates both
    // queries before the transaction wraps them, which no test double can model
    // as rolling back. The saving is a few milliseconds on a path that is about
    // to spend seconds in an LLM call; being able to test the rollback is worth
    // more.
    claim = await prisma.$transaction(async (tx) => {
      const row = await upsertChannelUsage(tx, channelId, yearMonth, reservation, false);
      const hold = await tx.channelBudgetHold.create({
        data: {
          amountUsd: reservation,
          channelId,
          expiresAt: new Date(Date.now() + CHANNEL_HOLD_TTL_MS),
          yearMonth,
        },
        select: { id: true },
      });
      // The post-increment total, so this is what the channel had spent before
      // this turn laid claim to anything.
      return { accruedBefore: Number(row.costUsdAccrued) - reservation, holdId: hold.id };
    });
  } catch (err) {
    console.error(
      `[channelAssistant] failed to reserve channel budget for ${channelId}:`,
      err instanceof Error ? err.message : err
    );
  }

  if (claim === null) {
    // The ledger write failed. Fall back to the read-only gate rather than
    // blocking the turn: this row backs a cap, not billing, and the run-level
    // ledger still records the spend.
    return (await isChannelOverBudgetNow(channelId, monthlyBudgetUsdCents))
      ? REFUSED_HOLD
      : makeHold(channelId, yearMonth, 0, null);
  }

  if (isChannelOverBudget(claim.accruedBefore, monthlyBudgetUsdCents)) {
    // Before refusing, reclaim anything abandoned — the total this decided on
    // includes holds no one is spending against. Only paid on the refusal path,
    // and only re-read when the sweep actually reclaimed something.
    const reclaimed = await sweepExpiredHolds(channelId);
    const accruedBefore =
      reclaimed > 0
        ? (await accruedThisMonth(channelId, yearMonth)) - reservation
        : claim.accruedBefore;
    if (isChannelOverBudget(accruedBefore, monthlyBudgetUsdCents)) {
      await releaseHold(channelId, yearMonth, claim.holdId, reservation);
      return REFUSED_HOLD;
    }
  }
  return makeHold(channelId, yearMonth, reservation, claim.holdId);
}

/**
 * The answer when the channel is at its cap: nothing was held, so there is
 * nothing to give back. Shared rather than built per refusal, which makes "a
 * refused hold holds nothing" structural instead of four call sites remembering
 * to pass a zero.
 */
const REFUSED_HOLD: ChannelBudgetHold = {
  overBudget: true,
  settle: async () => {},
};

/**
 * Drops a hold row and takes its amount back off the ledger.
 *
 * Same protocol as {@link consumeHold}, which is the point — a release is a
 * settle for a cost of zero, and giving them one implementation stops the
 * delete-is-the-claim invariant from being maintained twice.
 */
async function releaseHold(
  channelId: string,
  yearMonth: string,
  holdId: string,
  amountUsd: number
): Promise<void> {
  try {
    await consumeHold(channelId, yearMonth, holdId, -amountUsd, false);
  } catch (err) {
    console.error(
      `[channelAssistant] failed to release a budget hold for ${channelId}:`,
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * In one transaction: drop a hold row and apply `deltaUsd` to the ledger.
 *
 * Deleting the row *is* the claim — a raised delete is how the caller learns
 * someone else (a sweep, an admin reset) already accounted for this hold, which
 * is why the delete goes first and why this has to roll back as a unit.
 */
function consumeHold(
  channelId: string,
  yearMonth: string,
  holdId: string,
  deltaUsd: number,
  countRun: boolean
): Promise<unknown> {
  return prisma.$transaction(async (tx) => {
    await tx.channelBudgetHold.delete({ where: { id: holdId } });
    await upsertChannelUsage(tx, channelId, yearMonth, deltaUsd, countRun);
  });
}

function makeHold(
  channelId: string,
  yearMonth: string,
  reservedUsd: number,
  holdId: string | null
): ChannelBudgetHold {
  let settled = false;
  return {
    overBudget: false,
    async settle(costUsd: number, opts: { countRun?: boolean } = {}): Promise<void> {
      if (settled) {
        return;
      }
      settled = true;
      const countRun = opts.countRun ?? true;
      if (holdId === null) {
        // Nothing held and nothing spent: an uncapped channel whose background
        // pass made no model call has no reason to materialise a usage row.
        if (costUsd === 0 && !countRun) {
          return;
        }
        await addChannelUsage(channelId, yearMonth, costUsd, countRun);
        return;
      }
      try {
        // Deleting the row is what proves the hold was still ours. If a sweep
        // beat us to it the reservation has already been refunded, so the real
        // cost is owed in full rather than net of it.
        await consumeHold(channelId, yearMonth, holdId, costUsd - reservedUsd, countRun);
      } catch {
        // Two ways in, one right answer. Either the delete raised because the
        // hold is gone (swept, or released by an admin reset) and the
        // reservation is already off the ledger; or the whole transaction rolled
        // back, leaving the hold in place to be swept at its TTL. Both owe the
        // full cost, un-netted — netting here would either double-refund the
        // reservation or charge against a hold that no longer exists.
        await addChannelUsage(channelId, yearMonth, costUsd, countRun);
      }
    },
  };
}

/**
 * Shared resolve-spec → `runAgent` core for both channel paths (the assistant
 * turn and the ambient digest). Resolves the channel's configured agent through
 * the Agent library with the CHANNEL config tier active (`ctx.channelId`, with
 * team/org cascading after), runs one generation against `userMessage`, and
 * returns the trimmed reply text plus the authoritative per-turn USD cost.
 *
 * Deliberately does NOT touch the channel budget. {@link runHeldChannelTurn}
 * wraps it with a hold that spans exactly the model call; this stays budget-free
 * for the one caller that needs the pieces separately.
 */
export async function runChannelAgentTurn(
  channel: {
    id: string;
    agentKey: string;
    teamId: string;
    orgId: string;
    personaPrompt?: string | null;
  },
  userMessage: string,
  spanName: string,
  /**
   * Phase A: optional extra tools (e.g. `delegateTask`) merged into the resolved
   * spec, and an optional prompt note describing them. Omitted for the ambient
   * digest path (it has no delegate affordance).
   */
  extras?: { tools?: AgentTools; promptNote?: string }
): Promise<{ reply: string; costUsd: number }> {
  const agentKey = channel.agentKey || DEFAULT_CHANNEL_AGENT_KEY;

  // CHANNEL tier fires because `channelId` is set; team/org tiers cascade after it.
  const spec = await resolveAgentSpec(
    { agentKey: agentKey as ModelBackedAgentKey, basePrompt: '' },
    { channelId: channel.id, orgId: channel.orgId, teamId: channel.teamId }
  );

  // Persona: prepend before any other additions so callers' promptNote and tool
  // hints land at the END of the system prompt where the model weighs them highest.
  spec.systemPrompt = applyPersona(spec.systemPrompt, channel.personaPrompt ?? null);

  // Merge any extra tools (delegateTask) onto the resolved spec, and append the
  // prompt note so the agent knows the affordance exists. The spec's own tools
  // win on a key collision (defensive — `delegateTask` is a reserved key here).
  if (extras?.tools) {
    spec.tools = { ...extras.tools, ...spec.tools } as AgentTools;
  }
  if (extras?.promptNote) {
    spec.systemPrompt = `${spec.systemPrompt}${extras.promptNote}`;
  }

  const result = await runAgent(spec, userMessage, { spanName });

  return { costUsd: result.costUsd ?? 0, reply: (result.text ?? '').trim() };
}

/** A turn that ran, with the budget it is holding until the caller settles. */
export interface HeldChannelTurn {
  hold: ChannelBudgetHold;
  reply: string;
  costUsd: number;
}

/**
 * {@link runChannelAgentTurn} with the channel's budget held across it.
 *
 * Returns `null` when the channel is at its cap — nothing was held and nothing
 * spent, so the caller just takes its own "no reply" path.
 *
 * The release-on-throw lives here rather than at each call site. Four callers
 * were writing the same reserve → bail → try/catch-release → settle dance around
 * this one function, and a fifth that forgot the release would strand budget for
 * the rest of the month with nothing to catch it. Settling stays with the caller:
 * they disagree on whether the turn counts as a run.
 */
export async function runHeldChannelTurn(
  channel: {
    id: string;
    agentKey: string;
    teamId: string;
    orgId: string;
    personaPrompt?: string | null;
    monthlyBudgetUsdCents: number | null;
  },
  userMessage: string,
  spanName: string,
  extras?: { tools?: AgentTools; promptNote?: string; modelCalls?: number }
): Promise<HeldChannelTurn | null> {
  const hold = await reserveChannelTurn(channel.id, channel.monthlyBudgetUsdCents, {
    agentKey: channel.agentKey || DEFAULT_CHANNEL_AGENT_KEY,
    modelCalls: extras?.modelCalls,
    orgId: channel.orgId,
    teamId: channel.teamId,
  });
  if (hold.overBudget) {
    return null;
  }
  try {
    const turn = await runChannelAgentTurn(channel, userMessage, spanName, extras);
    return { ...turn, hold };
  } catch (err) {
    // A turn that never produced a reply also never spent its hold.
    await hold.settle(0, { countRun: false });
    throw err;
  }
}

/**
 * Channel assistant (Phase 1). One conversational turn for a channel-resident Slack
 * assistant: load the channel's configured agent key, resolve it through the
 * Agent library with the CHANNEL config tier active (`ctx.channelId`), and
 * generate a reply to the user's message.
 *
 * Per-channel budget:
 *  - Pre-turn: a cheap read bails an already-capped channel with a friendly
 *    "budget reached" reply, then {@link reserveChannelTurn} holds for the two
 *    model calls this turn can make — the reply and the memory summarizer — so
 *    concurrent turns cannot all pass the same read.
 *  - Post-turn: the hold settles to the real cost of both calls, best-effort. A
 *    failure to record usage must never break the reply.
 *
 * Trace persistence + the workflow-level `recordLlmUsage` accounting are handled
 * inside {@link runAgent}; the channel-monthly accrual below is an independent,
 * channel-scoped ledger used purely for the per-channel cap.
 */
export async function runChannelAssistantTurn(input: ChannelAssistantTurnInput): Promise<{
  reply: string;
  delegate?: DelegateIntent;
  generate?: GenerateWorkflowIntent;
  refine?: RefineWorkflowIntent;
  /** Gap H: set when a follow-up turn decided the message wasn't addressed to it
   *  (SKIP) — the workflow then delivers nothing. */
  suppressed?: boolean;
}> {
  const channel = await prisma.slackChannel.findUnique({
    select: {
      agentKey: true,
      monthlyBudgetUsdCents: true,
      personaPrompt: true,
      team: { select: { defaultPersonaPrompt: true } },
    },
    where: { id: input.channelId },
  });
  const agentKey = channel?.agentKey || DEFAULT_CHANNEL_AGENT_KEY;

  // Cheap pre-turn bail so an over-budget channel does no prompt-building work.
  // This read decides nothing on its own — the hold taken around the model call
  // below is what actually enforces the cap under concurrency.
  if (await isChannelOverBudgetNow(input.channelId, channel?.monthlyBudgetUsdCents ?? null)) {
    return { reply: BUDGET_EXCEEDED_REPLY };
  }

  // Phase 2: retrieve channel-scoped memory similar to this message and prepend
  // it as context, so the assistant builds knowledge over time. Best-effort —
  // a retrieval failure (e.g. embedding round-trip) must not block the reply.
  let memory: ChannelMemoryItem[] = [];
  try {
    memory = await retrieveChannelMemory(input.userText, {
      channelId: input.channelId,
      teamId: input.teamId,
    });
  } catch (err) {
    console.error(
      `[channelAssistant] failed to retrieve channel memory for ${input.channelId}:`,
      err instanceof Error ? err.message : err
    );
  }

  // Thread-history refinement: fetch the recent replies in the thread we're
  // replying in so the assistant sees the actual conversation, not just memory.
  // BEST-EFFORT and DEGRADES GRACEFULLY: `fetchThreadReplies` returns `[]` on a
  // missing token, a hung fetch, or an unauthorized response (e.g. the
  // `channels:history` scope not yet granted), so an empty transcript simply
  // yields a normal memory-only turn — it never throws.
  let thread: SlackThreadMessage[] = [];
  try {
    thread = await fetchThreadReplies(input.slackChannelId, input.threadTs);
  } catch (err) {
    // Defensive: fetchThreadReplies already swallows its own errors, but guard
    // the call site too so a thread-context failure can never break the reply.
    console.error(
      `[channelAssistant] failed to fetch thread replies for ${input.channelId}:`,
      err instanceof Error ? err.message : err
    );
  }

  // Compose context: channel memory block first, then the thread transcript, then
  // the user's message at the bottom (closest to the model's attention).
  const withMemory = formatMemoryContext(memory, input.userText);
  const userMessage = formatThreadContext(thread, withMemory);

  // Phase 4: scan the ingested channel message — untrusted user input fed to the
  // LLM — for injection/exfiltration patterns. ADVISORY only (mirrors the
  // implementer's LLM-output scanner): warnings are recorded as a named security
  // event, but the turn always proceeds. Wrapped in try/catch so a scanner/DB
  // failure never aborts the turn. We scan only `input.userText`, not the
  // prepended memory context — that originated from prior, already-scanned input.
  await scanChannelInput(input);

  // Phase A: give the agent a `delegateTask` tool so it can launch a durable,
  // thread-bound task run when the mention is a multi-step task rather than a
  // quick question. The tool only RECORDS the intent (captured into `delegate`
  // below); the workflow launches the run after the turn returns.
  let delegate: DelegateIntent | undefined;
  const delegateTool = buildDelegateTool((intent) => {
    delegate = intent;
  });

  // Give the agent a `generateWorkflow` tool so it can draft a reusable workflow
  // template when the user asks to create an automation. Records the intent here;
  // the workflow generates + persists the DRAFT after the turn.
  let generate: GenerateWorkflowIntent | undefined;
  const generateWorkflowTool = buildGenerateWorkflowTool((intent) => {
    generate = intent;
  });

  // Give the agent a `refineWorkflow` tool so a follow-up in the same thread can
  // adjust the draft it already created. Records the intent; the workflow resolves
  // the thread's current draft and applies the change after the turn.
  let refine: RefineWorkflowIntent | undefined;
  const refineWorkflowTool = buildRefineWorkflowTool((intent) => {
    refine = intent;
  });

  // Resolve the effective persona (channel overrides team default) and pass it
  // into runChannelAgentTurn so it's prepended to the system prompt.
  const personaPrompt = await resolvePersonaPrompt(
    channel?.personaPrompt,
    channel?.team?.defaultPersonaPrompt
  );

  // Resolve the channel's agent (CHANNEL tier active) + run one generation. The
  // base note advertises delegate + generate + refine tools; a follow-up
  // continuation turn (Gap H) also appends the SKIP-aware intent note so the
  // agent stays out of conversations that aren't addressed to it.
  const baseToolNote = `${DELEGATE_TOOL_PROMPT_NOTE}${GENERATE_WORKFLOW_TOOL_PROMPT_NOTE}${REFINE_WORKFLOW_TOOL_PROMPT_NOTE}`;
  const promptNote = input.followup
    ? `${baseToolNote}${FOLLOWUP_INTENT_PROMPT_NOTE}`
    : baseToolNote;
  // A concurrent turn that would take the channel past its cap is refused here
  // rather than after the fact.
  const turn = await runHeldChannelTurn(
    {
      agentKey,
      id: input.channelId,
      monthlyBudgetUsdCents: channel?.monthlyBudgetUsdCents ?? null,
      orgId: input.orgId,
      personaPrompt,
      teamId: input.teamId,
    },
    userMessage,
    'llm.channel_assistant',
    {
      // The turn itself plus the post-turn memory summarizer.
      modelCalls: 2,
      promptNote,
      tools: {
        delegateTask: delegateTool,
        generateWorkflow: generateWorkflowTool,
        refineWorkflow: refineWorkflowTool,
      } as AgentTools,
    }
  );
  if (!turn) {
    return { reply: BUDGET_EXCEEDED_REPLY };
  }
  const { reply, costUsd } = turn;

  // Gap H intent gate: a follow-up turn that decided the message wasn't for it
  // (and didn't fire a tool) is suppressed — the cost already happened (budget
  // bounds it) but nothing is posted, so the assistant doesn't inject itself into
  // human-to-human chatter. Settle before returning so the budget still sees it.
  if (input.followup && !delegate && !generate && !refine && SKIP_SENTINEL.test(reply)) {
    await turn.hold.settle(costUsd);
    return { reply: '', suppressed: true };
  }

  // Persist this exchange as channel-scoped memory so future turns can retrieve
  // it. Best-effort — a failure here must never break the reply. Only write
  // non-trivial replies (skip terse acknowledgements). Refinement: distill the
  // exchange into a durable fact via a cheap summarizer pass instead of storing
  // the raw transcript (see {@link summarizeAndStoreChannelMemory}).
  //
  // The summarizer is a second model call on this channel, so its cost settles
  // against the same hold — `runHeldChannelTurn` reserved for both. Settling
  // after it, rather than before, is what keeps it inside the cap.
  const summaryCostUsd =
    reply.length > MIN_MEMORY_REPLY_LENGTH ? await summarizeAndStoreChannelMemory(input, reply) : 0;

  // Swap the hold for the authoritative `costUsd` returned by runAgent (priced by
  // the agent KEY's configured model) so the per-channel ledger prices identically
  // to the run-level ledger rather than re-deriving cost from the raw spec string.
  // Best-effort: a failure here must NOT break the reply — the workflow-level
  // ledger (recordLlmUsage inside runAgent) is the source of truth for billing;
  // this row only backs the per-channel cap.
  await turn.hold.settle(costUsd + summaryCostUsd);

  // The action intents are mutually exclusive — the workflow handles each with an
  // early return, so a co-fired lower-precedence intent would be silently dropped.
  // Resolve to one by precedence: generate (new) > refine (change existing) >
  // delegate (one-off task), keeping the most specific authoring intent.
  if (generate && (refine || delegate)) {
    console.warn(
      `[channelAssistant] generateWorkflow co-fired with another intent for ${input.channelId}; preferring generateWorkflow`
    );
    refine = undefined;
    delegate = undefined;
  } else if (refine && delegate) {
    console.warn(
      `[channelAssistant] refineWorkflow co-fired with delegateTask for ${input.channelId}; preferring refineWorkflow`
    );
    delegate = undefined;
  }

  const ackFallback =
    delegate || generate || refine
      ? "On it — I'll follow up in this thread when it's done."
      : "I wasn't able to come up with a response. Could you rephrase?";
  return { delegate, generate, refine, reply: reply || ackFallback };
}

/**
 * Refinement (summarizing memory pass). Distill the (userText, reply) exchange
 * into a durable `{ lessonSummary, rationale }` fact via ONE cheap summarization
 * call, then store the SUMMARY (not the raw transcript) as channel memory so the
 * channel accumulates durable knowledge rather than a conversation log.
 *
 * Reuses the {@link MEMORY_SUMMARIZER_PROMPT} framing and resolves the
 * `commitToMemory` model-backed role via {@link resolveAgentSpec} + {@link runAgent}
 * with a structured-output schema — the same approach as `commitToMemory`.
 *
 * BEST-EFFORT, never breaks the reply:
 *  - The summarizer's USD cost is accrued to the channel ledger (it's a real LLM
 *    call on the channel).
 *  - On any failure (summarizer throws, returns no object, or the memory write
 *    fails) we FALL BACK to storing the truncated raw exchange so memory still
 *    accrues. A failure in the fallback path is itself swallowed + logged.
 */
async function summarizeAndStoreChannelMemory(
  input: ChannelAssistantTurnInput,
  reply: string
): Promise<number> {
  let costUsd = 0;
  try {
    const spec = await resolveAgentSpec(
      {
        agentKey: 'commitToMemory' as ModelBackedAgentKey,
        outputSchema: ChannelMemorySummarySchema,
        // Override the role's default prompt with the channel-exchange framing.
        promptOverride: CHANNEL_MEMORY_SUMMARIZER_PROMPT,
      },
      { channelId: input.channelId, orgId: input.orgId, teamId: input.teamId }
    );

    const exchange = JSON.stringify({ assistantReply: reply, userMessage: input.userText });
    const result = await runAgent<z.infer<typeof ChannelMemorySummarySchema>>(spec, exchange, {
      spanName: 'llm.channel_memory_summary',
    });

    // The summarizer is a real LLM call on the channel. Its cost goes back to the
    // caller, which settles it against the same hold as the turn that triggered
    // it — a second unheld call would spend outside the cap.
    costUsd = result.costUsd ?? 0;

    const summary = result.object;
    if (!summary?.lessonSummary) {
      throw new Error('channel memory summarizer returned no structured output');
    }

    await writeChannelMemory({
      channelId: input.channelId,
      orgId: input.orgId,
      rationale: summary.rationale.slice(0, MEMORY_RATIONALE_MAX_CHARS),
      summary: summary.lessonSummary.slice(0, MEMORY_SUMMARY_MAX_CHARS),
      teamId: input.teamId,
      userSlackId: input.userSlackId,
    });
  } catch (err) {
    // Summarization (or its write) failed — fall back to storing the truncated
    // raw exchange so channel memory still accrues. Never let this break the reply.
    console.error(
      `[channelAssistant] memory summarization failed for ${input.channelId}, ` +
        `falling back to raw-exchange store:`,
      err instanceof Error ? err.message : err
    );
    try {
      await writeChannelMemory({
        channelId: input.channelId,
        orgId: input.orgId,
        rationale: input.userText.slice(0, MEMORY_RATIONALE_MAX_CHARS),
        summary: reply.slice(0, MEMORY_SUMMARY_MAX_CHARS),
        teamId: input.teamId,
        userSlackId: input.userSlackId,
      });
    } catch (fallbackErr) {
      console.error(
        `[channelAssistant] fallback raw-exchange memory write failed for ${input.channelId}:`,
        fallbackErr instanceof Error ? fallbackErr.message : fallbackErr
      );
    }
  }
  return costUsd;
}

/**
 * Increment the channel's current-month usage row with one turn's USD cost and
 * (optionally) a completed-run count. The `costUsd` is the authoritative per-turn
 * cost returned by {@link runAgent} (priced by `recordLlmUsage` against the agent
 * KEY's configured model), so this per-channel ledger prices identically to the
 * run-level ledger — no re-pricing here.
 *
 * `countRun` (default `true`) controls whether `runsCompleted` is incremented.
 * User-facing turns count as a run; background maintenance passes (channel-memory
 * consolidation) accrue their LLM cost to the budget but pass `countRun: false`
 * so they don't inflate the channel's reported run count.
 *
 * Uses Prisma's `increment` upsert (race-safe across concurrent turns in the
 * same channel), mirroring the `OrgMonthlyUsage` accrual in `finalizeWorkflowRun`.
 * Wrapped in try/catch so a DB error degrades to "reply still sent".
 */
export async function accrueChannelUsage(
  channelId: string,
  costUsd: number,
  opts: { countRun?: boolean } = {}
): Promise<void> {
  await addChannelUsage(channelId, currentYearMonth(), costUsd, opts.countRun ?? true);
}

/**
 * The only statement that writes `ChannelMonthlyUsage`.
 *
 * Takes its client so the hold paths can run it inside the transaction that
 * also writes the `ChannelBudgetHold` row — an increment without its row, or a
 * row without its increment, is exactly the state the sweeper cannot reason
 * about. Errors propagate; {@link addChannelUsage} is the best-effort wrapper.
 */
function upsertChannelUsage(
  client: Pick<typeof prisma, 'channelMonthlyUsage'>,
  channelId: string,
  yearMonth: string,
  deltaUsd: number,
  countRun: boolean
) {
  return client.channelMonthlyUsage.upsert({
    create: {
      channelId,
      costUsdAccrued: deltaUsd,
      runsCompleted: countRun ? 1 : 0,
      yearMonth,
    },
    select: { costUsdAccrued: true },
    update: {
      costUsdAccrued: { increment: deltaUsd },
      ...(countRun ? { runsCompleted: { increment: 1 } } : {}),
    },
    where: { channelId_yearMonth: { channelId, yearMonth } },
  });
}

/**
 * The one best-effort write to `ChannelMonthlyUsage`. The budget row backs a cap,
 * not billing, so every caller degrades to "the turn still happens" rather than
 * propagating a write failure.
 *
 * `deltaUsd` may be negative: {@link reserveChannelTurn} releases a hold that
 * way, and {@link ChannelBudgetHold.settle} nets a hold against a smaller real
 * cost. The row can never go below what was actually spent, because a release
 * only ever removes an increment this process made to the same `yearMonth` row
 * — which is why the caller passes the month rather than this re-reading it.
 */
async function addChannelUsage(
  channelId: string,
  yearMonth: string,
  deltaUsd: number,
  countRun: boolean
): Promise<void> {
  try {
    await upsertChannelUsage(prisma, channelId, yearMonth, deltaUsd, countRun);
  } catch (err) {
    // Best-effort: never let a budget-ledger write failure break the reply.
    console.error(
      `[channelAssistant] failed to accrue channel usage for ${channelId}:`,
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Post the assistant's reply back into the originating Slack thread. Delegates
 * to the shared {@link postSlackThreadMessage} helper (resolves the per-workspace
 * bot token for the target channel, never `process.env`).
 */
export async function postChannelReply(args: {
  slackChannelId: string;
  threadTs: string;
  text: string;
}): Promise<void> {
  await postSlackThreadMessage(args.slackChannelId, args.threadTs, args.text);
}

/**
 * Channel assistant (Phase 4): advisory injection/exfiltration scan of the ingested
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
 * Channel assistant (Phase 4): post the "working on it" placeholder into the thread and
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
 * Channel assistant (Phase 4): edit a previously posted placeholder in place with the
 * final reply (or a friendly error) via Slack `chat.update`.
 */
export async function updateChannelReply(args: {
  slackChannelId: string;
  ts: string;
  text: string;
}): Promise<void> {
  await updateSlackMessage(args.slackChannelId, args.ts, args.text);
}
