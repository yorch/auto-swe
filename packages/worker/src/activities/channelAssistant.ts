import { prisma } from '@auto-swe/shared/db';
import { CHANNEL_MEMORY_SUMMARIZER_PROMPT } from '@auto-swe/shared/lib/agentPrompts';
import { currentYearMonth } from '@auto-swe/shared/lib/billing';
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
import type { AgentTools } from '../lib/config/agentSpec.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import type { ModelBackedAgentKey } from '../lib/config/types.js';
import {
  fetchThreadReplies,
  postSlackThreadMessage,
  postSlackThreadMessageReturningTs,
  type SlackThreadMessage,
  updateSlackMessage,
} from '../lib/slackNotify.js';
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
 * System-prompt note appended for the assistant turn: tells the agent it can
 * launch a durable background task via `delegateTask` for genuine multi-step
 * work, versus answering inline for quick questions.
 */
const DELEGATE_TOOL_PROMPT_NOTE = [
  '',
  'You have a `delegateTask` tool. Use it ONLY when the user is asking you to ',
  'carry out a genuine multi-step task (e.g. "investigate X and summarise", ',
  '"draft the migration plan", "build Y") rather than answer a quick question. ',
  'When you call it, a durable background run is launched that works the task ',
  'and reports back in this thread — so your own reply should be a brief ',
  'acknowledgement ("On it — I\'ll follow up here."). For quick questions, just ',
  'answer directly and do NOT call the tool. Set route="code" only when the task ',
  'requires editing a repository / opening a pull request; otherwise route="general". ',
  'For a code task, if the user named a specific repository, pass it as `repoHint` ',
  '(e.g. "payments-api" or "acme/payments-api"); leave it unset if no repo was named. ',
  'If the user explicitly asks to defer the task to a specific future time (e.g. ',
  '"tomorrow at 9am", "next Monday", "in 2 hours"), pass an ISO 8601 UTC timestamp as ',
  '`runAt` (e.g. "2026-06-26T09:00:00Z"). Leave `runAt` unset for immediate execution.',
].join('');

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

/**
 * Shared pre-LLM budget gate for both the assistant turn and the ambient digest.
 * Returns `true` when the channel has a positive `monthlyBudgetUsdCents` cap and
 * the current month's accrued spend has reached it. When no cap is set, returns
 * `false` immediately without issuing any query (the no-cap fast path — channels
 * without a cap pay no extra DB round-trip).
 *
 * Centralises the cap-set → read(ChannelMonthlyUsage) → `Number(...)` →
 * {@link isChannelOverBudget} sequence so the assistant and ambient paths stay in
 * lockstep (same read, same predicate).
 *
 * BUDGET GUARANTEE ("at most one in-flight turn can overshoot"):
 *   This is the strongest *pragmatic* cap for post-hoc LLM cost. The actual cost
 *   of a turn is not known until AFTER the model responds, so a turn cannot
 *   reserve its (unknown) spend before running — a perfectly hard cap would
 *   require a cost-estimation/reservation system, which is deliberately out of
 *   scope. Instead we read the accrued total inside a Serializable transaction so
 *   the read reflects all *committed* accruals (no stale snapshot under
 *   concurrency), then accrue the real cost post-turn via {@link accrueChannelUsage}.
 *   The window that remains: while one turn is mid-flight (LLM call running, cost
 *   not yet committed), a second turn can read the not-yet-incremented total and
 *   pass the gate. So once the cap is reached, AT MOST ONE additional turn can
 *   slip through and overshoot — never an unbounded stampede. After that turn's
 *   cost commits, every subsequent gate read sees it and blocks. This matches the
 *   org-budget soft cap at work-request submit; both accept a single-turn
 *   overshoot rather than build cost estimation.
 */
export async function isChannelOverBudgetNow(
  channelId: string,
  monthlyBudgetUsdCents: number | null
): Promise<boolean> {
  if (monthlyBudgetUsdCents == null || monthlyBudgetUsdCents <= 0) {
    return false;
  }
  // Serializable read so the accrued total can't be a stale snapshot taken before
  // a concurrently-committed accrual — tightening (not eliminating; see the
  // guarantee above) the race window for post-hoc cost.
  const accruedUsd = await prisma.$transaction(
    async (tx) => {
      const usage = await tx.channelMonthlyUsage.findUnique({
        select: { costUsdAccrued: true },
        where: {
          channelId_yearMonth: { channelId, yearMonth: currentYearMonth() },
        },
      });
      return usage ? Number(usage.costUsdAccrued) : 0;
    },
    { isolationLevel: 'Serializable' }
  );
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

/**
 * Channel assistant (Phase 1). One conversational turn for a channel-resident Slack
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
): Promise<{ reply: string; delegate?: DelegateIntent }> {
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

  // Resolve the effective persona (channel overrides team default) and pass it
  // into runChannelAgentTurn so it's prepended to the system prompt.
  const personaPrompt = await resolvePersonaPrompt(
    channel?.personaPrompt,
    channel?.team?.defaultPersonaPrompt
  );

  // Resolve the channel's agent (CHANNEL tier active) + run one generation.
  const { reply, costUsd } = await runChannelAgentTurn(
    { agentKey, id: input.channelId, orgId: input.orgId, personaPrompt, teamId: input.teamId },
    userMessage,
    'llm.channel_assistant',
    { promptNote: DELEGATE_TOOL_PROMPT_NOTE, tools: { delegateTask: delegateTool } as AgentTools }
  );

  // Post-turn channel-scoped accrual. Best-effort: a failure here must NOT break
  // the reply — the workflow-level ledger (recordLlmUsage inside runAgent) is the
  // source of truth for billing; this row only backs the per-channel cap. We
  // accrue the authoritative `costUsd` returned by runAgent (priced by the agent
  // KEY's configured model) so the per-channel ledger prices identically to the
  // run-level ledger rather than re-deriving cost from the raw spec string.
  await accrueChannelUsage(input.channelId, costUsd);

  // Persist this exchange as channel-scoped memory so future turns can retrieve
  // it. Best-effort — a failure here must never break the reply. Only write
  // non-trivial replies (skip terse acknowledgements). Refinement: distill the
  // exchange into a durable fact via a cheap summarizer pass instead of storing
  // the raw transcript (see {@link summarizeAndStoreChannelMemory}).
  if (reply.length > MIN_MEMORY_REPLY_LENGTH) {
    await summarizeAndStoreChannelMemory(input, reply);
  }

  // When the agent delegated, prefer its (brief) ack but always surface a
  // sensible fallback. The workflow decides whether to launch based on `delegate`.
  const ackFallback = delegate
    ? "On it — I'll follow up in this thread when it's done."
    : "I wasn't able to come up with a response. Could you rephrase?";
  return { delegate, reply: reply || ackFallback };
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
): Promise<void> {
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

    // The summarizer is a real LLM call on the channel — account its cost too.
    await accrueChannelUsage(input.channelId, result.costUsd ?? 0);

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
  const countRun = opts.countRun ?? true;
  try {
    const yearMonth = currentYearMonth();
    await prisma.channelMonthlyUsage.upsert({
      create: {
        channelId,
        costUsdAccrued: costUsd,
        runsCompleted: countRun ? 1 : 0,
        yearMonth,
      },
      update: {
        costUsdAccrued: { increment: costUsd },
        ...(countRun ? { runsCompleted: { increment: 1 } } : {}),
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
