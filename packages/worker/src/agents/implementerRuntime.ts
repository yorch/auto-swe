import type { Agent } from '@mastra/core/agent';
import { ApplicationFailure } from '@temporalio/activity';
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
import { failedCallAttribution } from '../lib/llmAttribution.js';
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

const tracedFailures = new WeakSet<object>();

/**
 * Whether `runImplementerTurn` already wrote the `llm_response` row for this
 * failure. A caller that adds its own row for a failed turn skips it then, or the
 * turn's spend is traced twice. Only an object can be marked; the turn's own
 * failures are errors.
 */
export function wasTurnTraced(err: unknown): boolean {
  return typeof err === 'object' && err !== null && tracedFailures.has(err);
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
   * The resolved `Agent` row (id + version) the turn runs as, stamped on its trace row. Null
   * only where no `Agent` row ran.
   */
  agent: { id: string; version: number } | null;
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
 * `onRecorded` sees each call's attribution as soon as the ledger holds it. A
 * call whose debit then throws `BUDGET_EXCEEDED` was paid for and debited too,
 * and carries its own attribution on the failure, so that is reported before the
 * error propagates.
 */
async function accrue(
  turn: Pick<ImplementerTurn, 'role' | 'usageEvent'>,
  spent: { modelSpec?: string; usage: TokenUsage }[],
  onRecorded?: (recorded: LlmAttribution) => void
): Promise<LlmAttribution> {
  let attribution: LlmAttribution = NO_SPEND;
  for (const [i, { modelSpec, usage }] of spent.entries()) {
    let recorded: LlmAttribution;
    try {
      recorded = await recordLlmUsage(
        currentWorkflowId(),
        turn.role,
        usage,
        turn.usageEvent,
        modelSpec
      );
    } catch (err) {
      const paid = failedCallAttribution(err, modelSpec);
      if (paid.inputTokens !== undefined) {
        onRecorded?.({
          costUsd: paid.costUsd ?? 0,
          inputTokens: paid.inputTokens,
          modelSpec: paid.model ?? '',
          outputTokens: paid.outputTokens ?? 0,
        });
      }
      throw err;
    }
    onRecorded?.(recorded);
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
 * `debited` is everything the turn has been charged so far, by either route, and
 * is what an aborted turn's trace row reports; `charge` debits usage the runtime
 * reports at the end of the turn into the same total.
 */
export function perCallAccounting(turn: Pick<ImplementerTurn, 'role' | 'usageEvent'>): {
  onCallSpent: (spent: { modelSpec: string; usage: TokenUsage }[]) => Promise<void>;
  charge: (spent: { modelSpec?: string; usage: TokenUsage }[]) => Promise<void>;
  debited: () => LlmAttribution;
} {
  let total = NO_SPEND;
  const charge = async (spent: { modelSpec?: string; usage: TokenUsage }[]) => {
    await accrue(turn, spent, (recorded) => {
      total = combine(total, recorded);
    });
  };
  return {
    charge,
    debited: () => total,
    onCallSpent: async (spent) => {
      await charge(spent);
      // The next call must have something left to spend.
      await assertBudgetAvailable(`agent.${turn.role}`);
    },
  };
}

const ABORT_ERROR_MAX_CHARS = 1000;

/**
 * The one `llm_response` row of a turn that was aborted after spending: without it
 * the spend is on the run's ledger but on no trace, so rollups and the run viewer
 * lose exactly the runs that went wrong. A turn that spent nothing records nothing.
 * Best-effort: tracing must never replace the error the turn is failing with.
 */
function recordAbortedTurn(
  turn: ImplementerTurn,
  attribution: LlmAttribution,
  err: unknown,
  durationMs: number
): void {
  if (!(attribution.costUsd > 0 || attribution.inputTokens > 0 || attribution.outputTokens > 0)) {
    return;
  }
  try {
    const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    turn.tracer.addLlmResponse({
      agent: turn.agent,
      costUsd: attribution.costUsd,
      durationMs,
      error: text.slice(0, ABORT_ERROR_MAX_CHARS),
      inputJson: { ...turn.context, systemPrompt: turn.system, userMessage: turn.user },
      inputTokens: attribution.inputTokens,
      model: attribution.modelSpec || undefined,
      outputTokens: attribution.outputTokens,
      role: turn.role,
    });
    if (typeof err === 'object' && err !== null) {
      tracedFailures.add(err);
    }
  } catch (traceErr: unknown) {
    logWarn('[implementer] could not trace an aborted turn', {
      error: traceErr instanceof Error ? traceErr.message : String(traceErr),
      usageEvent: turn.usageEvent,
    });
  }
}

/**
 * One implementer turn plus the bookkeeping every caller owes it: accrue the
 * usage against the run's budget, run the advisory output scan, and record the
 * LLM call on the tracer. This is the ONE implementation the TDD loop, the fix
 * sessions, the eval harness and the merge-conflict resolver used to copy.
 *
 * The caller still owns `assertBudgetAvailable` (it must run before the call and
 * must not be traced as a model call): a throw from the runtime or from the
 * budget check propagates untouched. A runtime failure that carries what the
 * turn spent ({@link withSpentUsage}) has that usage accrued first. A turn that
 * fails after spending gets one `llm_response` row with that usage and the error;
 * the original error is what propagates, even if accrual or tracing fails.
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
    // What the runtime reports at the end (the whole turn, for the Mastra loop) is
    // debited into the same total; its debit can trip the budget, and the turn then
    // fails having spent, which the catch below records.
    await accounting.charge(
      outcome.usageByModel ??
        (outcome.usage ? [{ modelSpec: turn.boundModelSpec, usage: outcome.usage }] : [])
    );
  } catch (err) {
    // The remainder a runtime's failure says it still owed joins what the budget
    // check already saw, so the row cannot drift from the ledger.
    const owedOnFailure = spentUsageOf(err);
    if (owedOnFailure) {
      await accounting.charge(owedOnFailure).catch((accrueErr: unknown) => {
        // A turn stopped by the budget is over the cap, so debiting what it still owed
        // trips the same check again after the ledger has taken the debit: no warning.
        if (accrueErr instanceof ApplicationFailure && accrueErr.type === 'BUDGET_EXCEEDED') {
          return;
        }
        logWarn('[implementer] could not accrue the usage of a failed turn', {
          error: accrueErr instanceof Error ? accrueErr.message : String(accrueErr),
          usageEvent: turn.usageEvent,
        });
      });
    }
    recordAbortedTurn(turn, accounting.debited(), err, Date.now() - start);
    throw err;
  }
  const attribution = accounting.debited();

  // LLM output scanner — advisory, non-blocking (the helper never throws).
  await recordSuspiciousLlmOutput(turn.tracer, outcome.text ?? '', { inputJson: turn.context });

  // Recorded even when the model only made tool calls: the tool calls are already
  // on the tracer, and this is the row that carries the prompt, the cost and the
  // turn they belong to.
  turn.tracer.addLlmResponse({
    agent: turn.agent,
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
