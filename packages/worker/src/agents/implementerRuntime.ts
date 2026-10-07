import type { Agent } from '@mastra/core/agent';
import { currentWorkflowId } from '../lib/activityContext.js';
import { logWarn } from '../lib/activityLog.js';
import type { AgentTracer } from '../lib/agentTracer.js';
import { abortSignalOption } from '../lib/cancellation.js';
import {
  assertBudgetAvailable,
  type LlmAttribution,
  recordLlmUsage,
  type TokenUsage,
} from '../lib/costTracking.js';
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
  /** Model calls the turn made, when the runtime counts them. */
  steps?: number;
  /**
   * Set when the turn ended before the model finished: it used its whole step
   * budget, or a caller's deadline stopped it. Neither is a failure.
   */
  stoppedReason?: 'max_steps' | 'wall_clock';
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

/** One turn's prompt, and how the caller meters it. */
export interface ImplementerTurnInput {
  system: string;
  user: string;
  /**
   * Per-call accounting: called, one at a time, with each model call's usage
   * once the call is complete, while the turn runs. It debits the call and may
   * then throw (the run's budget is exhausted); the turn is aborted and fails
   * with that error. A call handed here is not reported again in the turn's
   * usage. A runtime that cannot see its calls one by one (the Mastra loop
   * reports a turn's usage when it ends) ignores it.
   */
  onCallSpent?: (spent: SpentByModel) => Promise<void>;
}

/**
 * Drives one model turn against the workspace the implementer is bound to. It
 * only runs the loop; usage, scanning and tracing belong to `runImplementerTurn`
 * so every runtime is governed the same way.
 */
export interface ImplementerRuntime {
  runTurn(input: ImplementerTurnInput): Promise<ImplementerTurnOutcome>;
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

const NO_SPEND: LlmAttribution = { costUsd: 0, inputTokens: 0, modelSpec: '', outputTokens: 0 };

/** Two attributions as one, named for `a`'s model unless it has none. */
function combine(a: LlmAttribution, b: LlmAttribution): LlmAttribution {
  return {
    costUsd: a.costUsd + b.costUsd,
    inputTokens: a.inputTokens + b.inputTokens,
    modelSpec: a.modelSpec || b.modelSpec,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.pricingKnown === false || b.pricingKnown === false ? { pricingKnown: false } : {}),
  };
}

/**
 * Accrue a turn's usage against the run's budget, one model at a time, and
 * return the combined attribution (named for the model that spent the most).
 */
async function accrue(
  turn: Pick<ImplementerTurn, 'role' | 'usageEvent'>,
  spent: { modelSpec?: string; usage: TokenUsage }[]
): Promise<LlmAttribution> {
  let attribution: LlmAttribution = NO_SPEND;
  for (const [i, { modelSpec, usage }] of spent.entries()) {
    const recorded = await recordLlmUsage(
      currentWorkflowId(),
      turn.role,
      usage,
      turn.usageEvent,
      modelSpec
    );
    attribution = i === 0 ? recorded : combine(attribution, recorded);
  }
  return attribution;
}

/**
 * Per-call accounting for one turn (`ImplementerTurnInput.onCallSpent`): each
 * model call is debited to the run's ledger as soon as the runtime has finished
 * it, then the budget is re-checked, so a long harness turn cannot overshoot its
 * tier by more than the call in flight — the guarantee the Mastra loop's
 * per-step accounting gives an agent run. A check that fails throws
 * (`BUDGET_EXCEEDED`), and the runtime ends the turn with that error.
 * `debited` is what the turn has been charged this way so far.
 */
export function perCallAccounting(turn: Pick<ImplementerTurn, 'role' | 'usageEvent'>): {
  onCallSpent: (spent: { modelSpec: string; usage: TokenUsage }[]) => Promise<void>;
  debited: () => LlmAttribution;
} {
  let total = NO_SPEND;
  return {
    debited: () => total,
    onCallSpent: async (spent) => {
      total = combine(total, await accrue(turn, spent));
      // The next call must have something left to spend.
      await assertBudgetAvailable(`agent.${turn.role}`);
    },
  };
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
export async function runImplementerTurn(turn: ImplementerTurn): Promise<{
  attribution: LlmAttribution;
  text?: string;
  steps?: number;
  stoppedReason?: ImplementerTurnOutcome['stoppedReason'];
}> {
  const start = Date.now();
  // Every turn is metered per call where the runtime can see its calls.
  const accounting = perCallAccounting(turn);
  let outcome: ImplementerTurnOutcome;
  try {
    outcome = await turn.runtime.runTurn({
      onCallSpent: accounting.onCallSpent,
      system: turn.system,
      user: turn.user,
    });
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
  const owed = await accrue(turn, spent);
  // The calls debited as the turn ran come first, so the row is named for them.
  const attribution = combine(accounting.debited(), owed);

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

  return {
    attribution,
    steps: outcome.steps,
    stoppedReason: outcome.stoppedReason,
    text: outcome.text,
  };
}
