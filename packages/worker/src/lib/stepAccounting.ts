import { currentWorkflowId } from './activityContext.js';
import { activityCancellationSignal } from './cancellation.js';
import { assertBudgetAvailable, type LlmAttribution, recordLlmUsage } from './costTracking.js';

/**
 * Per-step budget accounting for a long tool loop (see `RunAgentOptions.perStepAccounting`).
 *
 * Mastra reports each finished step through `onStepFinish`. This debits that
 * step's usage to the run ledger immediately and re-checks the budget, so:
 *
 *  - a loop of hundreds of steps cannot overshoot its tier by an unbounded
 *    amount (the one pre-call check only covers the first step);
 *  - an aborted call (wall-clock deadline, cancellation, a provider error
 *    mid-loop) has already recorded every step that completed;
 *  - a step that exhausts the budget aborts the loop, and the `BUDGET_EXCEEDED`
 *    failure is surfaced by the caller after `generate` settles — an aborted
 *    generate may resolve with `finishReason: 'aborted'` rather than throw, so
 *    the reason cannot ride on the abort itself.
 */
export interface StepAccounting {
  /** Merged signal: activity cancellation + caller deadline + budget stop. */
  signal: AbortSignal;
  onStepFinish: (step: StepLike) => Promise<void>;
  /** Throw the budget failure, or the activity's cancellation reason, if either occurred. */
  throwIfBudgetOrCancelled: () => void;
  /** True when the caller's own abort signal (the deadline) fired. */
  deadlineHit: () => boolean;
  stepCount: () => number;
  lastText: () => string | undefined;
  /** Summed attribution of every recorded step. */
  totals: () => LlmAttribution;
}

/** The slice of Mastra's step result this depends on. */
export interface StepLike {
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  text?: string;
}

export function createStepAccounting(
  agentKey: string,
  spanName: string,
  deadline?: AbortSignal,
  modelSpec?: string
): StepAccounting {
  const budgetStop = new AbortController();
  const cancel = activityCancellationSignal();
  const signals = [budgetStop.signal, ...(deadline ? [deadline] : []), ...(cancel ? [cancel] : [])];
  const signal = AbortSignal.any(signals);

  let budgetError: unknown;
  let steps = 0;
  let lastText: string | undefined;
  const totals: LlmAttribution = { costUsd: 0, inputTokens: 0, modelSpec: '', outputTokens: 0 };

  return {
    deadlineHit: () => deadline?.aborted === true && cancel?.aborted !== true && !budgetError,
    lastText: () => lastText,
    onStepFinish: async (step) => {
      steps += 1;
      if (step.text) {
        lastText = step.text;
      }
      if (budgetError) {
        return;
      }
      try {
        // Mastra also reports a failed step, with zero usage: nothing to debit.
        if (step.usage && (step.usage.inputTokens || step.usage.outputTokens)) {
          const a = await recordLlmUsage(
            currentWorkflowId(),
            agentKey,
            { inputTokens: step.usage.inputTokens, outputTokens: step.usage.outputTokens },
            spanName,
            modelSpec
          );
          totals.costUsd += a.costUsd;
          totals.inputTokens += a.inputTokens;
          totals.outputTokens += a.outputTokens;
          totals.modelSpec = a.modelSpec || totals.modelSpec;
          totals.pricingKnown = (totals.pricingKnown ?? true) && a.pricingKnown !== false;
        }
        // The next step must have something left to spend.
        await assertBudgetAvailable(`agent.${agentKey}`);
      } catch (e) {
        budgetError = e;
        budgetStop.abort(e);
      }
    },
    signal,
    stepCount: () => steps,
    throwIfBudgetOrCancelled: () => {
      if (budgetError) {
        throw budgetError;
      }
      cancel?.throwIfAborted();
    },
    totals: () => ({ ...totals }),
  };
}
