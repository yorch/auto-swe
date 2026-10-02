import { configCacheTtlMs, withCache } from '@auto-swe/shared/config/cache';
import { prisma } from '@auto-swe/shared/db';
import { BUILTIN_MODELS, builtinModelSpec } from '@auto-swe/shared/lib/builtinModels';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import type { BudgetTier } from '@auto-swe/shared/types/workflow';
import { type Span, trace } from '@opentelemetry/api';
import { ApplicationFailure, log } from '@temporalio/activity';
import { currentActivityType, currentWorkflowId } from './activityContext.js';
import { logWarn } from './activityLog.js';
import { gatedStepNames } from './config/deploymentAgents.js';
import { STEP_REQUIRED_AGENTS } from './config/stepRequiredAgents.js';
import { recordBudgetExceeded, recordLlmCallMetrics } from './metrics.js';
import { getModelSpec, type ModelBackedAgentKey } from './models.js';

const tracer = trace.getTracer('auto-swe-worker');

export interface ModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

/**
 * Built-in prices keyed by `<provider>/<model-id>`, USD per million tokens: a
 * view over `BUILTIN_MODELS` in `@auto-swe/shared/lib/builtinModels`. Pricing
 * reads the model catalog first and falls back to this table, so a model is
 * still priced before the gateway has seeded the catalog or while the database
 * is unreachable.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.fromEntries(
  BUILTIN_MODELS.map((m) => [
    builtinModelSpec(m),
    { input: m.inputUsdPerMTok, output: m.outputUsdPerMTok },
  ])
);

const ZERO_PRICE: ModelPrice = { input: 0, output: 0 };

export type PriceSource = 'catalog' | 'builtin' | 'unknown';

const MODEL_CATALOG_CACHE_KEY = 'model-catalog:prices';

/** The last catalog read that succeeded; prices calls while the catalog is unreadable. */
let lastGoodCatalog: ReadonlyMap<string, ModelPrice> | null = null;
/** After a failed read, the catalog is not queried again before this time. */
let catalogRetryAt = 0;

/** A negative or non-finite rate would invert cost accrual and slip past USD budgets. */
function isValidPrice(input: number, output: number): boolean {
  return Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0;
}

/**
 * The catalog's prices, read once per config-cache window. Never throws: a
 * failed read serves the last good catalog (or none, so built-in prices apply)
 * and backs off for one window. `withCache` does not cache a rejection, so
 * without the backoff an unreachable database would cost a query per LLM call.
 */
async function catalogPrices(): Promise<ReadonlyMap<string, ModelPrice> | null> {
  if (Date.now() < catalogRetryAt) {
    return lastGoodCatalog;
  }
  try {
    lastGoodCatalog = await withCache(MODEL_CATALOG_CACHE_KEY, configCacheTtlMs(), async () => {
      const rows = await prisma.modelCatalogEntry.findMany({
        select: { inputUsdPerMTok: true, modelId: true, outputUsdPerMTok: true, provider: true },
      });
      const prices = new Map<string, ModelPrice>();
      for (const r of rows) {
        if (isValidPrice(r.inputUsdPerMTok, r.outputUsdPerMTok)) {
          prices.set(`${r.provider}/${r.modelId}`, {
            input: r.inputUsdPerMTok,
            output: r.outputUsdPerMTok,
          });
        }
      }
      return prices;
    });
  } catch (err) {
    catalogRetryAt = Date.now() + configCacheTtlMs();
    // Through the context-guarded logger: embedding usage is priced outside an
    // activity too, where `log` itself throws.
    logWarn(
      'Model catalog unreadable — pricing from the last catalog read, else the built-in prices',
      {
        error: err instanceof Error ? err.message : String(err),
      }
    );
  }
  return lastGoodCatalog;
}

export function _resetModelPricesForTests(): void {
  lastGoodCatalog = null;
  catalogRetryAt = 0;
}

/**
 * Looks up the cost rate for a model spec: the model catalog, then the built-in
 * table, else zero with `known=false`. The lookup is exact — a near-miss such as
 * `gpt-5-5` for `gpt-5.5` is unknown, never silently priced as its neighbour.
 */
export async function getModelPrice(
  spec: string
): Promise<{ price: ModelPrice; known: boolean; source: PriceSource }> {
  const fromCatalog = (await catalogPrices())?.get(spec);
  if (fromCatalog) {
    return { known: true, price: fromCatalog, source: 'catalog' };
  }
  const builtin = MODEL_PRICES[spec];
  if (builtin) {
    return { known: true, price: builtin, source: 'builtin' };
  }
  return { known: false, price: ZERO_PRICE, source: 'unknown' };
}

/**
 * `MODEL_PRICE_*` variables set in `env`. They once overrode a model's price and
 * are no longer read — the worker names them at startup so an operator moves
 * those prices into the model catalog instead of losing them silently.
 */
export function ignoredPriceOverrideVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env)
    .filter((k) => k.startsWith('MODEL_PRICE_'))
    .sort();
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
export async function calculateCostUsd(
  modelSpec: string,
  inputTokens: number,
  outputTokens: number
): Promise<number> {
  return costFromPrice((await getModelPrice(modelSpec)).price, inputTokens, outputTokens);
}

function costFromPrice(price: ModelPrice, inputTokens: number, outputTokens: number): number {
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
  /**
   * False when the model had no known price, so `costUsd` is a recorded $0 rather
   * than a measured zero. Absent on a hand-built attribution (no call was made).
   */
  pricingKnown?: boolean;
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
  const workflow = await prisma.activeWorkflow.findFirst({
    select: {
      budgetTier: true,
      costUsdAccrued: true,
      tokensInputUsed: true,
      tokensOutputUsed: true,
    },
    where: { temporalWorkflowId },
  });
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
 * **Scoped to what the gate walked.** Most LLM-spending activities are not step
 * executors — channel turns, the memory passes, the workflow-authoring
 * activities — and `assertConfigReady` covers those by separate rules (a
 * channel implies `channelAssistant`, and so on). Judging them against a map of
 * *steps* would report drift on every healthy deployment, which is how an
 * advisory signal becomes noise nobody reads. So an activity the gate never
 * walked is not judged here.
 *
 * Advisory by construction. This is bookkeeping; it must never fail a run that
 * has already paid the provider. The span attribute is the durable signal.
 */
const warnedUnregistered = new Set<string>();

function flagUnregisteredAgentUsage(role: string, span: Span): void {
  let activity: string;
  try {
    activity = currentActivityType();
  } catch {
    return; // Outside an activity (tests, direct calls) — nothing to check.
  }
  // `null` means the gate has not run in this process, so there is no basis to
  // judge anything — stay quiet rather than guess.
  if (!gatedStepNames()?.has(activity)) {
    return;
  }
  const declared = STEP_REQUIRED_AGENTS[activity];
  if (declared === null) {
    return; // Its agent comes from the spec — no static entry can exist.
  }
  // No entry at all means the step resolves no model *as far as the map knows*;
  // an entry that omits this role means the map is incomplete for it. Both are
  // drift, and only steps that actually reach here can be judged.
  if (declared?.includes(role)) {
    return;
  }
  // The span attribute is per-run and free, so it stays unconditional. The log
  // line is once per (step, agent) per process: a drifted entry on a hot step
  // would otherwise repeat identically on every call and bury itself.
  span.setAttribute('llm.step_agent_unregistered', true);
  const seen = `${activity}:${role}`;
  if (warnedUnregistered.has(seen)) {
    return;
  }
  warnedUnregistered.add(seen);
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
  spanName = 'llm.usage',
  boundModelSpec?: string
): Promise<LlmAttribution> {
  // Resolve the spec defensively: if the DB row is corrupt (missing `/`,
  // unknown provider, decrypt failure) we still need to debit the token
  // counters for budget enforcement. Without this guard, malformed config
  // would let an activity burn unlimited tokens (each retry re-spends at
  // the provider but never updates the DB counter → BUDGET_EXCEEDED never
  // fires).
  //
  // `boundModelSpec` is the spec the caller actually bound for this call. When
  // given it is priced as-is: re-resolving `role` from the ambient activity
  // context cannot see a CHANNEL tier, an owning-team override the caller chose
  // not to use, or an explicit `key@version` pin, so it would price a different
  // model than the one that was paid for. Omitted, the role is re-resolved.
  let modelSpec: string;
  let specResolutionError: unknown;
  try {
    // `role` is identity-agnostic here; getModelSpec resolves the DB row by the
    // role string. Pricing below is keyed on the resolved spec, not the role.
    modelSpec = boundModelSpec || (await getModelSpec(role as ModelBackedAgentKey));
  } catch (err) {
    modelSpec = 'unknown/unknown';
    specResolutionError = err;
  }
  const { known, price, source } = await getModelPrice(modelSpec);
  if (!known) {
    log.warn(
      'Unknown model pricing — cost will be recorded as $0 and USD budgets will not see it. Add the model to the model catalog.',
      { modelSpec, role, temporalWorkflowId }
    );
  }

  // Capture resolved token counts for attribution before entering the span so
  // they're available for the fallback return path (no workflow found).
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const callCost = costFromPrice(price, inputTokens, outputTokens);
  // Before the ledger: a call with no ledger row (channel, PRD, authoring) was
  // still made and paid for.
  recordLlmCallMetrics({
    agent: role,
    costUsd: callCost,
    inputTokens,
    model: modelSpec,
    outputTokens,
  });

  const attribution = await tracer.startActiveSpan(
    spanName,
    async (span): Promise<LlmAttribution> => {
      try {
        if (specResolutionError) {
          span.setAttribute('llm.spec_resolution_failed', true);
          span.recordException(specResolutionError as Error);
        }
        // Per-call facts do not depend on the ledger, so they are set before it
        // is touched: a run with no ledger row (channel, PRD, authoring) still
        // spent tokens, and its span should say so.
        span.setAttributes({
          'llm.cost_price_source': source,
          'llm.cost_pricing_known': known,
          'llm.cost_usd': callCost,
          'llm.input_tokens': inputTokens,
          'llm.model': modelSpec,
          'llm.output_tokens': outputTokens,
          'llm.role': role,
        });
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
          return { costUsd: callCost, inputTokens, modelSpec, outputTokens, pricingKnown: known };
        }

        const newInput = Number(updated.tokensInputUsed);
        const newOutput = Number(updated.tokensOutputUsed);
        const newCost = updated.costUsdAccrued;

        span.setAttributes({
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
          recordBudgetExceeded(tier);
          throw ApplicationFailure.nonRetryable(
            `Budget exceeded for tier ${tier}: ${newInput}/${limits.inputTokens} input tokens, ${newOutput}/${limits.outputTokens} output tokens used ($${newCost.toFixed(4)})`,
            'BUDGET_EXCEEDED',
            {
              // The call was made and the ledger debited; carry its attribution
              // so the caller's trace row is priced (see failedCallAttribution).
              attribution: { costUsd: callCost, inputTokens, modelSpec, outputTokens },
              newCost,
              newInput,
              newOutput,
              tier,
            }
          );
        }

        return { costUsd: callCost, inputTokens, modelSpec, outputTokens, pricingKnown: known };
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
