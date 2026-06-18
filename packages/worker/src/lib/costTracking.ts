import { prisma } from '@auto-swe/shared/db';
import type { BudgetTier } from '@auto-swe/shared/types/workflow';
import { trace } from '@opentelemetry/api';
import { ApplicationFailure } from '@temporalio/activity';
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

export const BUDGET_LIMITS: Record<BudgetTier, { inputTokens: number; outputTokens: number }> = {
  EPIC: { inputTokens: 20_000_000, outputTokens: 5_000_000 },
  LARGE: { inputTokens: 8_000_000, outputTokens: 2_000_000 },
  STANDARD: { inputTokens: 2_000_000, outputTokens: 500_000 },
};

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
        const workflow = await prisma.activeWorkflow.findFirst({
          select: {
            budgetTier: true,
            costUsdAccrued: true,
            id: true,
            tokensInputUsed: true,
            tokensOutputUsed: true,
          },
          where: { temporalWorkflowId },
        });

        if (!workflow) {
          // Non-fatal: workflow record may not exist in test/dev scenarios
          span.setAttribute('llm.workflow_found', false);
          return { costUsd: callCost, inputTokens, modelSpec, outputTokens };
        }

        const newInput = workflow.tokensInputUsed + inputTokens;
        const newOutput = workflow.tokensOutputUsed + outputTokens;
        // ARCH-8: cost is a Float column accumulated incrementally; round each
        // accumulation to micro-dollars so FP representation error can't drift
        // across thousands of increments. (A Decimal column was considered and
        // rejected: Prisma Decimal serializes as a string, silently changing
        // the wire format of every endpoint that returns raw rows.)
        const newCost = Math.round((workflow.costUsdAccrued + callCost) * 1e6) / 1e6;

        span.setAttributes({
          'llm.cost_pricing_known': known,
          'llm.cost_usd': callCost,
          'llm.input_tokens': inputTokens,
          'llm.model': modelSpec,
          'llm.output_tokens': outputTokens,
          'llm.role': role,
          'workflow.budget_tier': workflow.budgetTier,
          'workflow.cost_usd_cumulative': newCost,
          'workflow.tokens_input_cumulative': newInput,
          'workflow.tokens_output_cumulative': newOutput,
        });

        // Write usage to DB before checking the budget limit.
        // This is intentional: we record actual consumption even when the limit
        // is breached, so the UI shows the real overage rather than the last
        // value before the limit was hit.
        await prisma.activeWorkflow.update({
          data: { costUsdAccrued: newCost, tokensInputUsed: newInput, tokensOutputUsed: newOutput },
          where: { id: workflow.id },
        });

        const tier = (workflow.budgetTier ?? 'STANDARD') as BudgetTier;
        const limits = BUDGET_LIMITS[tier];
        if (!limits) {
          throw new Error(
            `Unknown budget tier "${tier}" — update BUDGET_LIMITS in costTracking.ts`
          );
        }

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
