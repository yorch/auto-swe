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
import type { StepLike } from '../lib/stepAccounting.js';

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
   * usage. A runtime that cannot see its calls one by one ignores it.
   */
  onCallSpent?: (spent: SpentByModel) => Promise<void>;
  /**
   * Debits a call without the budget check that follows it, and without throwing the
   * budget stop: for a call that finishes after the turn was stopped, or that nothing
   * follows. A runtime that meters per call and has none uses `onCallSpent`.
   */
  chargeCall?: (spent: SpentByModel) => Promise<void>;
  /** The spec the caller bound for the turn; a runtime that meters per call prices at it. */
  modelSpec?: string;
}

/**
 * Drives one model turn against the workspace the implementer is bound to. It
 * only runs the loop; usage, scanning and tracing belong to `runImplementerTurn`
 * so every runtime is governed the same way.
 */
export interface ImplementerRuntime {
  runTurn(input: ImplementerTurnInput): Promise<ImplementerTurnOutcome>;
}

/** What the Mastra step hook reads off a finished step. */
type MastraStep = StepLike & { finishReason?: string; toolCalls?: unknown[] };

/** Finish reasons after which Mastra ends the loop, given the step made no tool call. */
const TERMINAL_FINISH_REASONS = new Set(['stop', 'length', 'content-filter', 'error']);

/**
 * `total` less `parts`, field by field and never below zero, carrying every usage
 * field (cache writes by TTL, the AI SDK's detail objects, reasoning tokens). The
 * counters a ledger prices are what matter: a remainder with no input and no output
 * is nothing.
 */
function usageLeft(total: TokenUsage, parts: TokenUsage[]): TokenUsage | undefined {
  const left = (whole: unknown, taken: unknown[]): unknown => {
    if (typeof whole === 'number') {
      const done = taken.reduce<number>((n, t) => n + (typeof t === 'number' ? t : 0), 0);
      return Math.max(0, whole - done);
    }
    if (typeof whole === 'object' && whole !== null) {
      return Object.fromEntries(
        Object.entries(whole).map(([key, value]) => [
          key,
          left(
            value,
            taken.map((t) =>
              typeof t === 'object' && t !== null ? Reflect.get(t, key) : undefined
            )
          ),
        ])
      );
    }
    return whole;
  };
  const rest = left(total, parts) as TokenUsage;
  return (rest.inputTokens ?? 0) > 0 || (rest.outputTokens ?? 0) > 0 ? rest : undefined;
}

/**
 * The Mastra tool loop. `maxSteps` is the `workspace.agentMaxSteps` budget:
 * without it Mastra stops a turn after 5 steps.
 *
 * With the turn's `onCallSpent`, each step is debited as it finishes (Mastra's
 * `onStepFinish`), one at a time. Mastra runs the model loop ahead of its hooks, so
 * a debit that throws aborts the loop some steps after the one that tripped it:
 * about one step when the debit is quick, up to every remaining step (`maxSteps`)
 * when it is slow. Steps that finish after the stop are still debited
 * (`chargeCall`, which does not check the budget) so the ledger holds every step
 * that ran. The held error, not the abort it caused, is what the turn fails with;
 * an aborted `generate` may also resolve instead of throw, so the error is
 * rethrown once it settles, carrying what the steps did not debit
 * ({@link withSpentUsage}). A final step (a terminal finish reason and no tool
 * call, so no model call follows) is debited without `assertBudgetAvailable`; the
 * debit itself still fails the turn if it takes the tier over its cap. The turn
 * reports only what the steps did not debit, so nothing is counted twice, and a
 * hook that delivered no usage leaves the whole turn total owed.
 */
export function mastraRuntime(
  agent: Pick<Agent, 'generate'>,
  maxSteps: number
): ImplementerRuntime {
  return {
    async runTurn({ system, user, onCallSpent, chargeCall, modelSpec = '' }) {
      const messages = [
        { content: system, role: 'system' as const },
        { content: user, role: 'user' as const },
      ];
      const accrued: SpentByModel = [];
      let debitError: { error: unknown } | undefined;
      const stop = new AbortController();
      const cancellation = abortSignalOption().abortSignal;
      // Hooks run in the order steps finish, and `generate` settling does not mean the
      // last one has.
      let hooks: Promise<void> = Promise.resolve();
      let stepNumber = 0;
      const charge = chargeCall ?? onCallSpent;
      const metering =
        onCallSpent && charge
          ? {
              abortSignal: AbortSignal.any([stop.signal, ...(cancellation ? [cancellation] : [])]),
              onStepFinish: (step: MastraStep) => {
                const work = async () => {
                  const { usage } = step;
                  // Mastra also reports a failed step, with zero usage: nothing to debit.
                  if (!(usage?.inputTokens || usage?.outputTokens)) {
                    return;
                  }
                  const spent = [
                    {
                      modelSpec,
                      usage: {
                        ...usage,
                        inputTokens: usage.inputTokens,
                        outputTokens: usage.outputTokens,
                      },
                    },
                  ];
                  // Counted as debited before the callback runs: one that throws after
                  // recording the spend (an exhausted budget) must not be charged again.
                  accrued.push(...spent);
                  stepNumber += 1;
                  // After the stop, or on a final step (Mastra continues unless the
                  // reason is terminal and no tool was called), only the debit is owed.
                  const final =
                    TERMINAL_FINISH_REASONS.has(step.finishReason ?? '') &&
                    !(step.toolCalls && step.toolCalls.length > 0);
                  const guarded = !debitError && !final;
                  try {
                    await (guarded ? onCallSpent : charge)(spent);
                  } catch (error) {
                    // The budget stop is the turn's failure; anything else is worth a line,
                    // since this step may be missing from the ledger.
                    if (
                      !(error instanceof ApplicationFailure && error.type === 'BUDGET_EXCEEDED')
                    ) {
                      logWarn('[implementer] could not debit a step of a Mastra turn', {
                        error: error instanceof Error ? error.message : String(error),
                        step: stepNumber,
                      });
                    }
                    if (!debitError) {
                      debitError = { error };
                      stop.abort(error);
                    }
                  }
                };
                const run = hooks.then(work);
                hooks = run;
                return run;
              },
            }
          : abortSignalOption();
      let result: Awaited<ReturnType<typeof agent.generate>> | undefined;
      let failure: { error: unknown } | undefined;
      try {
        result = await agent.generate(messages, { maxSteps, toolChoice: 'auto', ...metering });
      } catch (error) {
        failure = { error };
      }
      await hooks;
      // What the turn spent that no step debited, for a failure to carry.
      const unpaid = () => {
        const owed = result?.usage
          ? usageLeft(
              result.usage,
              accrued.map((a) => a.usage)
            )
          : undefined;
        return owed ? [{ modelSpec, usage: owed }] : undefined;
      };
      if (debitError) {
        // A debit that threw aborted the loop: that error, not the abort, is the failure.
        throw withSpentUsage(debitError.error, unpaid());
      }
      if (failure) {
        throw failure.error;
      }
      if (!result) {
        throw new Error('generate returned no result');
      }
      if (cancellation?.aborted) {
        // A cancelled turn still spent: what no step debited is carried on the failure.
        throw withSpentUsage(cancellation.reason, unpaid());
      }
      // A step is one model call, which may make several tool calls or none: count
      // the calls, as the harness runtime does.
      const toolCallCount = (result.steps ?? []).reduce(
        (n, step) => n + (step.toolCalls?.length ?? 0),
        0
      );
      const usage =
        accrued.length > 0 && result.usage
          ? usageLeft(
              result.usage,
              accrued.map((a) => a.usage)
            )
          : result.usage;
      return { text: result.text, toolCallCount, usage };
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
      chargeCall: accounting.charge,
      onCallSpent: accounting.onCallSpent,
      ...(turn.boundModelSpec ? { modelSpec: turn.boundModelSpec } : {}),
      system: turn.system,
      user: turn.user,
    });
    // What the runtime reports at the end (what it did not debit call by call) is
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
