import type { Agent } from '@mastra/core/agent';
import { currentWorkflowId } from '../lib/activityContext.js';
import { logWarn } from '../lib/activityLog.js';
import type { AgentTracer } from '../lib/agentTracer.js';
import { abortSignalOption } from '../lib/cancellation.js';
import { type LlmAttribution, recordLlmUsage, type TokenUsage } from '../lib/costTracking.js';
import { recordSuspiciousLlmOutput } from '../lib/llmOutputScan.js';

/** What the platform reads off one finished model turn, whatever drove the loop. */
export interface ImplementerTurnOutcome {
  text?: string;
  /** Tool calls made during the turn; the trace row reports it when there is no text. */
  toolCallCount: number;
  usage?: TokenUsage;
  /**
   * Usage split by the model that spent it, largest first, for a runtime whose
   * turn can span several models (a harness that delegates small tasks to a
   * cheaper one). Each entry is priced at its own spec; `usage` is ignored when
   * this is set.
   */
  usageByModel?: { modelSpec: string; usage: TokenUsage }[];
}

type SpentByModel = NonNullable<ImplementerTurnOutcome['usageByModel']>;

const spentBeforeFailure = new WeakMap<object, SpentByModel>();

/**
 * Marks a runtime's failure with what the turn spent before it failed, so
 * `runImplementerTurn` can still accrue it. A harness that ends with an error
 * result has already been billed for every model call it made; dropping that
 * usage would let a run that keeps failing spend without touching its budget.
 * The error itself is returned unchanged, so its type and retry policy stand.
 */
export function withSpentUsage<E>(err: E, usageByModel: SpentByModel | undefined): E {
  if (typeof err === 'object' && err !== null && usageByModel && usageByModel.length > 0) {
    spentBeforeFailure.set(err, usageByModel);
  }
  return err;
}

/** What {@link withSpentUsage} recorded on a failure, if anything. */
export function spentUsageOf(err: unknown): SpentByModel | undefined {
  return typeof err === 'object' && err !== null ? spentBeforeFailure.get(err) : undefined;
}

/**
 * Drives one model turn against the workspace the implementer is bound to. It
 * only runs the loop; usage, scanning and tracing belong to `runImplementerTurn`
 * so every runtime is governed the same way.
 */
export interface ImplementerRuntime {
  runTurn(input: { system: string; user: string }): Promise<ImplementerTurnOutcome>;
}

/**
 * The Mastra tool loop. `maxSteps` is the `workspace.agentMaxSteps` budget:
 * without it Mastra stops a turn after 5 steps.
 */
export function mastraRuntime(
  agent: Pick<Agent, 'generate'>,
  maxSteps: number
): ImplementerRuntime {
  return {
    async runTurn({ system, user }) {
      const result = await agent.generate(
        [
          { content: system, role: 'system' },
          { content: user, role: 'user' },
        ],
        { maxSteps, toolChoice: 'auto', ...abortSignalOption() }
      );
      // A step is one model call, which may make several tool calls or none: count
      // the calls, as the harness runtime does.
      const toolCallCount = (result.steps ?? []).reduce(
        (n, step) => n + (step.toolCalls?.length ?? 0),
        0
      );
      return { text: result.text, toolCallCount, usage: result.usage };
    },
  };
}

export interface ImplementerTurn {
  /**
   * The `<provider>/<model>` spec the caller actually bound for this turn, priced
   * as-is. Omitted, `recordLlmUsage` re-resolves `role` from the activity context,
   * which cannot see a model the caller chose outside the role's own cascade.
   */
  boundModelSpec?: string;
  /** Names the turn on its trace rows (iteration, attempt, eval case…). */
  context?: Record<string, unknown>;
  /** The agent identity the usage is attributed to. */
  role: string;
  runtime: ImplementerRuntime;
  system: string;
  tracer: AgentTracer;
  /** The span name `recordLlmUsage` records the call under. */
  usageEvent: string;
  user: string;
}

/**
 * Accrue a turn's usage against the run's budget, one model at a time, and
 * return the combined attribution (named for the model that spent the most).
 */
async function accrue(
  turn: ImplementerTurn,
  spent: { modelSpec?: string; usage: TokenUsage }[]
): Promise<LlmAttribution> {
  let attribution: LlmAttribution = { costUsd: 0, inputTokens: 0, modelSpec: '', outputTokens: 0 };
  for (const [i, { modelSpec, usage }] of spent.entries()) {
    const recorded = await recordLlmUsage(
      currentWorkflowId(),
      turn.role,
      usage,
      turn.usageEvent,
      modelSpec
    );
    attribution =
      i === 0
        ? recorded
        : {
            costUsd: attribution.costUsd + recorded.costUsd,
            inputTokens: attribution.inputTokens + recorded.inputTokens,
            modelSpec: attribution.modelSpec,
            outputTokens: attribution.outputTokens + recorded.outputTokens,
            pricingKnown: attribution.pricingKnown !== false && recorded.pricingKnown !== false,
          };
  }
  return attribution;
}

/**
 * One implementer turn plus the bookkeeping every caller owes it: accrue the
 * usage against the run's budget, run the advisory output scan, and record the
 * LLM call on the tracer. This is the ONE implementation the TDD loop, the fix
 * sessions, the eval harness and the merge-conflict resolver used to copy.
 *
 * The caller still owns `assertBudgetAvailable` (it must run before the call and
 * must not be traced as a model call) and any failure row: a throw from the
 * runtime or from the budget check propagates untouched. A runtime failure that
 * carries what the turn spent ({@link withSpentUsage}) has that usage accrued
 * first; the original error is what propagates, even if the accrual fails.
 */
export async function runImplementerTurn(
  turn: ImplementerTurn
): Promise<{ attribution: LlmAttribution; text?: string }> {
  const start = Date.now();
  let outcome: ImplementerTurnOutcome;
  try {
    outcome = await turn.runtime.runTurn({ system: turn.system, user: turn.user });
  } catch (err) {
    const spent = spentUsageOf(err);
    if (spent) {
      await accrue(turn, spent).catch((accrueErr: unknown) =>
        logWarn('[implementer] could not accrue the usage of a failed turn', {
          error: accrueErr instanceof Error ? accrueErr.message : String(accrueErr),
          usageEvent: turn.usageEvent,
        })
      );
    }
    throw err;
  }

  const spent =
    outcome.usageByModel ??
    (outcome.usage ? [{ modelSpec: turn.boundModelSpec, usage: outcome.usage }] : []);
  const attribution = await accrue(turn, spent);

  // LLM output scanner — advisory, non-blocking (the helper never throws).
  await recordSuspiciousLlmOutput(turn.tracer, outcome.text ?? '', { inputJson: turn.context });

  // Recorded even when the model only made tool calls: the tool calls are already
  // on the tracer, and this is the row that carries the prompt, the cost and the
  // turn they belong to.
  turn.tracer.addLlmResponse({
    costUsd: attribution.costUsd,
    durationMs: Date.now() - start,
    inputJson: { ...turn.context, systemPrompt: turn.system, userMessage: turn.user },
    inputTokens: attribution.inputTokens,
    model: attribution.modelSpec || undefined,
    outputJson: outcome.text ? { text: outcome.text } : { toolCallCount: outcome.toolCallCount },
    outputTokens: attribution.outputTokens,
    role: turn.role,
  });

  return { attribution, text: outcome.text };
}
