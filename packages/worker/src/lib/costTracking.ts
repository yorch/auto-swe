import { prisma } from '@auto-swe/shared/db';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import type { BudgetTier } from '@auto-swe/shared/types/workflow';
import { type Span, trace } from '@opentelemetry/api';
import { ApplicationFailure, log } from '@temporalio/activity';
import { currentActivityType, currentWorkflowId } from './activityContext.js';
import { configCacheTtlMs, withCache } from './config/cache.js';
import { DYNAMIC_AGENT_STEPS, STEP_REQUIRED_AGENTS } from './config/stepRequiredAgents.js';
import { getModelSpec, type ModelBackedAgentKey } from './models.js';

const tracer = trace.getTracer('auto-swe-worker');

export interface ModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

/**
 * Price table keyed by `<provider>/<model-id>`. USD per million tokens, base
 * (non-cached, non-batch) rates. Verified against:
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing  (May 2026)
 * - OpenAI:    https://openai.com/api/pricing
 * - Google:    https://ai.google.dev/gemini-api/docs/pricing
 *
 * Add new models here as they're routed through getModel(). Unknown specs fall
 * back to zero cost and emit `llm.cost_pricing_known=false` on the OTel span
 * so missing entries are visible without breaking workflows.
 *
 * Caveats this table does NOT account for — set per-model env overrides if any
 * apply to your deployment:
 *  - Prompt caching multipliers (0.1x reads, 1.25x/2x writes)
 *  - Batch API discount (50%)
 *  - Anthropic data-residency premium (1.1x for `inference_geo: us`)
 *  - Anthropic fast-mode premium (6x on Opus 4.6)
 *  - Gemini 2.5 Pro >200K-token surcharge (input doubles)
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'anthropic/claude-haiku-3-5-20241022': { input: 0.8, output: 4 },
  // Anthropic — Haiku
  'anthropic/claude-haiku-4-5-20251001': { input: 1, output: 5 },
  // Anthropic — Opus 4 / 4.1 (legacy pricing $15 / $75)
  'anthropic/claude-opus-4-1-20250805': { input: 15, output: 75 },
  'anthropic/claude-opus-4-5': { input: 5, output: 25 },
  'anthropic/claude-opus-4-6': { input: 5, output: 25 },
  // Anthropic — Opus 4.5+ family ($5 / $25)
  'anthropic/claude-opus-4-8': { input: 5, output: 25 },
  'anthropic/claude-opus-4-20250514': { input: 15, output: 75 },
  'anthropic/claude-sonnet-4-5': { input: 3, output: 15 },
  // Anthropic — Sonnet 4.x family ($3 / $15)
  'anthropic/claude-sonnet-4-6': { input: 3, output: 15 },
  'anthropic/claude-sonnet-4-20250514': { input: 3, output: 15 },
  'google/gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'google/gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  // Google — Gemini 2.5 (base prices; Pro input/output ~doubles above 200K context)
  'google/gemini-2.5-pro': { input: 1.25, output: 10 },
  'google/gemini-3-flash-preview': { input: 0.5, output: 3 },
  'google/gemini-3.1-flash-lite-preview': { input: 0.25, output: 1.5 },

  // Google — Gemini 3.x (current flagship line, all `-preview` as of May 2026)
  // Note: Gemini 3 Pro Preview was deprecated 2026-03-09 — use 3.1 Pro instead.
  'google/gemini-3.1-pro-preview': { input: 2, output: 12 },

  // OpenAI — base GPT-5 line (verified May 2026)
  'openai/gpt-5': { input: 1.25, output: 10 },
  'openai/gpt-5-5': { input: 5, output: 30 },
  'openai/gpt-5-5-pro': { input: 30, output: 180 },
};

const ZERO_PRICE: ModelPrice = { input: 0, output: 0 };

function parsePriceOverride(value: string): ModelPrice | null {
  const parts = value.split(':');
  if (parts.length !== 2) {
    return null;
  }
  const input = Number(parts[0]);
  const output = Number(parts[1]);
  if (!Number.isFinite(input) || !Number.isFinite(output)) {
    return null;
  }
  // Reject negative or NaN-derived rates: a negative override would invert cost
  // accumulation and could be used to bypass BUDGET_EXCEEDED.
  if (input < 0 || output < 0) {
    return null;
  }
  return { input, output };
}

/**
 * Looks up the cost rate for a model spec. Honours per-model env overrides of the
 * form `MODEL_PRICE_<PROVIDER>_<MODEL>=<input>:<output>` (USD per MTok), with
 * non-alphanumeric characters in the spec replaced by underscores. Falls back to
 * the static MODEL_PRICES table; unknown specs return zero with `known=false`.
 *
 * Negative or malformed overrides are ignored (fall through to the static table).
 */
export function getModelPrice(spec: string): { price: ModelPrice; known: boolean } {
  const envKey = `MODEL_PRICE_${spec.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const envValue = process.env[envKey];
  if (envValue) {
    const override = parsePriceOverride(envValue);
    if (override) {
      return { known: true, price: override };
    }
  }
  const price = MODEL_PRICES[spec];
  if (price) {
    return { known: true, price };
  }
  return { known: false, price: ZERO_PRICE };
}

/**
 * Baked-in per-tier token budgets. Retained as the fallback the DB-backed
 * resolver returns when no override row exists (identical numbers), and exported
 * for callers/tests that reference the defaults directly. The live values used
 * for enforcement come from `resolveBudgetTiers()` below.
 */
export const BUDGET_LIMITS: Record<BudgetTier, { inputTokens: number; outputTokens: number }> = {
  EPIC: { inputTokens: 20_000_000, outputTokens: 5_000_000 },
  LARGE: { inputTokens: 8_000_000, outputTokens: 2_000_000 },
  STANDARD: { inputTokens: 2_000_000, outputTokens: 500_000 },
};

/**
 * Resolve the per-tier token budgets from the DB-backed workflow defaults.
 *
 * `recordLlmUsage` is a hot path (called after every LLM call), so the resolved
 * value is memoized through the shared config TTL cache (`withCache`, same
 * ~30 s TTL as the model/credential resolvers) rather than hitting the DB per
 * call. A config edit in the dashboard takes effect on the next call after the
 * TTL elapses, mirroring how every other worker-side config resolution behaves.
 * With no override row the resolver returns the same numbers as `BUDGET_LIMITS`.
 */
async function resolveBudgetTiers(): Promise<
  Record<string, { inputTokens: number; outputTokens: number }>
> {
  return withCache('workflow-defaults:budgetTiers', configCacheTtlMs(), async () => {
    const defaults = await resolveWorkflowDefaults();
    return defaults.budgetTiers;
  });
}

/**
 * Computes the USD cost of a single LLM call given the model spec and token counts.
 * Returns 0 for unknown models — callers should rely on the OTel span attribute
 * `llm.cost_pricing_known` to detect missing entries.
 */
export function calculateCostUsd(
  modelSpec: string,
  inputTokens: number,
  outputTokens: number
): number {
  const { price } = getModelPrice(modelSpec);
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

interface TokenUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}

/**
 * Records LLM usage for a workflow after an agent.generate() call.
 * - Looks up the model bound to `role` and prices the call accordingly.
 * - Accumulates token counts and cost in the DB.
 * - Emits OTel span attributes for observability.
 * - Throws non-retryable BUDGET_EXCEEDED if the tier limit is breached.
 *
 * @param temporalWorkflowId - The Temporal workflow ID (used to look up the ActiveWorkflow record).
 * @param role - The agent identity that produced the usage. Identity-agnostic
 *   (any string) — it is used only for OTel attribution and to resolve the
 *   model spec. Pricing itself NEVER depends on the identity set: it is keyed
 *   purely on the resolved `<provider>/<model>` spec (getModelSpec → getModelPrice).
 * @param usage - Token usage from result.usage (Vercel AI SDK shape).
 * @param spanName - OTel span name for attribution (e.g., 'llm.implementer.iteration_1').
 */
export interface LlmAttribution {
  modelSpec: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Refuses an LLM call for a workflow that has already spent its tier.
 *
 * `recordLlmUsage` can only enforce *after* the provider has been paid — the
 * cost of a call is not known until it returns. That bounds a single call's
 * overshoot, but says nothing about calls already in flight beside it: the
 * review network fires three reviewers at once and `fanOut` runs branches in
 * parallel, so once one of them trips the limit the others would each still
 * spend a full call before their own post-check fired.
 *
 * Called before `generate()`, this turns that into one overshooting call rather
 * than one per concurrent branch. It is a gate, not a reservation: a workflow
 * sitting just under its limit is still allowed one more call of unknown size.
 * A true reservation needs a declared max-output-token budget per call site,
 * which the agent configs do not carry.
 *
 * Silent no-op when the workflow has no `ActiveWorkflow` ledger row (channel
 * tasks, PRD runs), matching `recordLlmUsage`.
 */
/**
 * Resolves a workflow's tier and its token caps, DB override first.
 *
 * Both the pre-flight gate and the post-call check need this, and they used to
 * derive it separately — which had already drifted: the gate returned silently
 * on an unknown tier while the check threw, so a misconfigured tier quietly
 * disabled the gate at every call site. One definition, one behaviour.
 */
async function resolveTierLimits(
  budgetTier: string | null
): Promise<{ tier: BudgetTier; limits: { inputTokens: number; outputTokens: number } }> {
  const tier = (budgetTier ?? 'STANDARD') as BudgetTier;
  const budgetTiers = await resolveBudgetTiers();
  const limits = budgetTiers[tier] ?? BUDGET_LIMITS[tier];
  if (!limits) {
    throw new Error(
      `Unknown budget tier "${tier}" — update the workflow-defaults budget tiers / BUDGET_LIMITS in costTracking.ts`
    );
  }
  return { limits, tier };
}

export async function assertBudgetAvailable(label = 'llm.call'): Promise<void> {
  // The workflow id comes from Temporal activity context, not the caller.
  // Passing it in invited exactly one bug: a call site supplied a literal
  // string that matched no ledger row, so its gate was a permanent silent
  // no-op. `persistActivityTrace` resolves its run the same way.
  const temporalWorkflowId = currentWorkflowId();
  const [workflow, _] = await Promise.all([
    prisma.activeWorkflow.findFirst({
      select: {
        budgetTier: true,
        costUsdAccrued: true,
        tokensInputUsed: true,
        tokensOutputUsed: true,
      },
      where: { temporalWorkflowId },
    }),
    // Independent of the row read; usually a cache hit, a second round trip
    // when the ~30 s TTL has expired.
    resolveBudgetTiers(),
  ]);
  if (!workflow) {
    return;
  }

  const { limits, tier } = await resolveTierLimits(workflow.budgetTier);
  const usedInput = Number(workflow.tokensInputUsed);
  const usedOutput = Number(workflow.tokensOutputUsed);
  // `>=` here, `>` in the post-check below, deliberately: a call that lands
  // exactly on the cap has spent its budget and is allowed, but the next call
  // has nothing left to spend.
  if (usedInput >= limits.inputTokens || usedOutput >= limits.outputTokens) {
    throw ApplicationFailure.nonRetryable(
      `Budget already exhausted for tier ${tier} before ${label}: ` +
        `${usedInput}/${limits.inputTokens} input tokens, ` +
        `${usedOutput}/${limits.outputTokens} output tokens used ` +
        `($${workflow.costUsdAccrued.toFixed(4)})`,
      'BUDGET_EXCEEDED',
      { label, tier, usedInput, usedOutput }
    );
  }
}

/**
 * Flags a step that spends tokens on an agent the boot gate does not know about.
 *
 * `STEP_REQUIRED_AGENTS` is hand-maintained, and a *missing* entry is the
 * damaging direction: the agent is never validated at startup, so a deployment
 * boots clean and the run dies partway through with `ConfigMissingError`. That
 * cannot be inferred statically without real call-graph analysis — one activity
 * module hosts several activities — but here both facts are in hand: which
 * activity is executing, and which agent key it just spent on.
 *
 * Advisory by construction. This is bookkeeping; it must never fail a run that
 * has already paid the provider. The span attribute is the durable signal.
 */
function flagUnregisteredAgentUsage(role: string, span: Span): void {
  let activity: string;
  try {
    activity = currentActivityType();
  } catch {
    return; // Outside an activity (tests, direct calls) — nothing to check.
  }
  if (DYNAMIC_AGENT_STEPS.has(activity)) {
    return; // Its agent comes from the spec — no static entry can exist.
  }
  const declared = STEP_REQUIRED_AGENTS[activity];
  // No entry at all means the step resolves no model *as far as the map knows*;
  // an entry that omits this role means the map is incomplete for it. Both are
  // drift, and only steps that actually reach here can be judged.
  if (declared?.includes(role as (typeof declared)[number])) {
    return;
  }
  span.setAttribute('llm.step_agent_unregistered', true);
  log.warn(
    `Step '${activity}' recorded usage for agent '${role}', which is not in ` +
      'STEP_REQUIRED_AGENTS. The boot gate cannot validate that agent, so a ' +
      'deployment missing its model or credential will fail mid-run instead of ' +
      'at startup. Add it to lib/config/stepRequiredAgents.ts.',
    { activity, role }
  );
}

export async function recordLlmUsage(
  temporalWorkflowId: string,
  role: string,
  usage: TokenUsage,
  spanName = 'llm.usage'
): Promise<LlmAttribution> {
  // Resolve the spec defensively: if the DB row is corrupt (missing `/`,
  // unknown provider, decrypt failure) we still need to debit the token
  // counters for budget enforcement. Without this guard, malformed config
  // would let an activity burn unlimited tokens (each retry re-spends at
  // the provider but never updates the DB counter → BUDGET_EXCEEDED never
  // fires).
  let modelSpec: string;
  let specResolutionError: unknown;
  try {
    // `role` is identity-agnostic here; getModelSpec resolves the DB row by the
    // role string. Pricing below is keyed on the resolved spec, not the role.
    modelSpec = await getModelSpec(role as ModelBackedAgentKey);
  } catch (err) {
    modelSpec = 'unknown/unknown';
    specResolutionError = err;
  }
  const { known } = getModelPrice(modelSpec);

  // Capture resolved token counts for attribution before entering the span so
  // they're available for the fallback return path (no workflow found).
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const callCost = calculateCostUsd(modelSpec, inputTokens, outputTokens);

  const attribution = await tracer.startActiveSpan(
    spanName,
    async (span): Promise<LlmAttribution> => {
      try {
        if (specResolutionError) {
          span.setAttribute('llm.spec_resolution_failed', true);
          span.recordException(specResolutionError as Error);
        }
        // Atomic increments, not read-modify-write.
        //
        // This used to read the counters, add locally, and write the sums back.
        // LLM calls are routinely concurrent — the review network runs three
        // reviewers under one `Promise.allSettled`, and `fanOut` branches run in
        // parallel, possibly on different workers — so interleaved read/write
        // pairs silently dropped increments. Budget enforcement then under-counted
        // exactly when spend was highest, and no in-process lock could fix it
        // because the writers are different processes. Postgres does the addition
        // now, and the returned row is the authoritative post-increment total.
        //
        // ARCH-8: cost is a Float column, so the *delta* is rounded to
        // micro-dollars before accumulating, keeping each increment exactly
        // representable. (A Decimal column was considered and rejected: Prisma
        // Decimal serializes as a string, silently changing the wire format of
        // every endpoint that returns raw rows.)
        //
        // Keyed on `temporalWorkflowId`, which is `@unique` — the same index the
        // launch path deduplicates on. Reading the row first to get its `id`
        // would double the round trips on the hottest path in the worker for
        // nothing.
        const costDelta = Math.round(callCost * 1e6) / 1e6;
        let updated: {
          budgetTier: string | null;
          costUsdAccrued: number;
          tokensInputUsed: bigint;
          tokensOutputUsed: bigint;
        };
        try {
          updated = await prisma.activeWorkflow.update({
            data: {
              costUsdAccrued: { increment: costDelta },
              tokensInputUsed: { increment: inputTokens },
              tokensOutputUsed: { increment: outputTokens },
            },
            select: {
              budgetTier: true,
              costUsdAccrued: true,
              tokensInputUsed: true,
              tokensOutputUsed: true,
            },
            where: { temporalWorkflowId },
          });
        } catch (err) {
          // P2025 — no ledger row. Non-fatal: channel tasks and PRD runs keep
          // none, and test/dev runs may not have one either.
          if ((err as { code?: string })?.code !== 'P2025') {
            throw err;
          }
          span.setAttribute('llm.workflow_found', false);
          return { costUsd: callCost, inputTokens, modelSpec, outputTokens };
        }

        const newInput = Number(updated.tokensInputUsed);
        const newOutput = Number(updated.tokensOutputUsed);
        const newCost = updated.costUsdAccrued;

        span.setAttributes({
          'llm.cost_pricing_known': known,
          'llm.cost_usd': callCost,
          'llm.input_tokens': inputTokens,
          'llm.model': modelSpec,
          'llm.output_tokens': outputTokens,
          'llm.role': role,
          'workflow.budget_tier': updated.budgetTier ?? 'STANDARD',
          'workflow.cost_usd_cumulative': newCost,
          'workflow.tokens_input_cumulative': newInput,
          'workflow.tokens_output_cumulative': newOutput,
        });

        // The write above happens before the limit check, deliberately: actual
        // consumption is recorded even when the limit is breached, so the UI
        // shows the real overage rather than the last value under the limit.
        flagUnregisteredAgentUsage(role, span);

        const { limits, tier } = await resolveTierLimits(updated.budgetTier);

        span.setAttributes({
          'workflow.budget_remaining_input_tokens': limits.inputTokens - newInput,
          'workflow.budget_remaining_output_tokens': limits.outputTokens - newOutput,
        });

        if (newInput > limits.inputTokens || newOutput > limits.outputTokens) {
          throw ApplicationFailure.nonRetryable(
            `Budget exceeded for tier ${tier}: ${newInput}/${limits.inputTokens} input tokens, ${newOutput}/${limits.outputTokens} output tokens used ($${newCost.toFixed(4)})`,
            'BUDGET_EXCEEDED',
            { newCost, newInput, newOutput, tier }
          );
        }

        return { costUsd: callCost, inputTokens, modelSpec, outputTokens };
      } catch (e) {
        span.recordException(e as Error);
        throw e;
      } finally {
        span.end();
      }
    }
  );

  return attribution;
}
