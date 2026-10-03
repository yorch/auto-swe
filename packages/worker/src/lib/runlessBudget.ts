import { AsyncLocalStorage } from 'node:async_hooks';
import { resolveSettings } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { ApplicationFailure } from '@temporalio/activity';
import { logWarn } from './activityLog.js';
import type { LlmAttribution } from './costTracking.js';
import { currentSpendOwner } from './spendOwner.js';
import { EMBEDDING_AGENT_KEY } from './traceTotals.js';

/**
 * The token cap for a workflow execution that keeps neither an `ActiveWorkflow`
 * ledger nor a `WorkflowRun` — workflow authoring and explaining, scheduled
 * evals, lesson consolidation, dependency inference.
 *
 * Such a workflow has no row to accrue onto, but every call it makes is already
 * written to `AgentTrace` with its workflow id and Temporal run id. So the
 * ledger here is that table: an execution's spend is the sum of its persisted
 * `llm_response` rows, plus the calls this process has recorded that are not
 * persisted yet (an activity writes its trace rows when it finishes, and one
 * eval case can make many calls before then). Embedding tokens are left out,
 * as they are from the tier counters.
 *
 * Bounded, not exact: calls in flight on another worker are invisible until
 * their activity persists, an activity's own tokens are invisible for the moment
 * its trace write is committing, and the rows of a failed trace write count only
 * on the worker that made the calls.
 */

/** Not-yet-persisted tokens per execution (`workflowId/temporalRunId`) in this process. */
const unpersisted = new Map<string, { input: number; output: number }>();
/** An activity that never persists would otherwise leave its entry forever. */
const MAX_TRACKED_EXECUTIONS = 1000;

const keyOf = (workflowId: string, temporalRunId: string) => `${workflowId}/${temporalRunId}`;

function addUnpersisted(key: string, input: number, output: number): void {
  const entry = unpersisted.get(key);
  if (entry) {
    entry.input += input;
    entry.output += output;
    return;
  }
  if (unpersisted.size >= MAX_TRACKED_EXECUTIONS) {
    // Oldest first: Map iterates in insertion order.
    const oldest = unpersisted.keys().next().value;
    if (oldest !== undefined) {
      unpersisted.delete(oldest);
    }
  }
  unpersisted.set(key, { input, output });
}

/**
 * An activity is about to persist rows carrying these tokens. They leave the
 * in-process sum before the write rather than after it, so a budget check on
 * the same execution that runs while the write commits never counts them twice.
 * Returns a function that puts back exactly what was taken, for a write that
 * failed: its rows never reach the trace sum, so the tokens must stay here.
 */
export function takePersistingUsage(
  workflowId: string,
  temporalRunId: string | null,
  input: number,
  output: number
): () => void {
  const noop = () => {};
  if (!temporalRunId) {
    return noop;
  }
  const key = keyOf(workflowId, temporalRunId);
  const entry = unpersisted.get(key);
  if (!entry) {
    return noop;
  }
  const taken = { input: Math.min(entry.input, input), output: Math.min(entry.output, output) };
  entry.input -= taken.input;
  entry.output -= taken.output;
  if (entry.input === 0 && entry.output === 0) {
    unpersisted.delete(key);
  }
  return () => {
    if (taken.input > 0 || taken.output > 0) {
      addUnpersisted(key, taken.input, taken.output);
    }
  };
}

const capScale = new AsyncLocalStorage<number>();

/**
 * Runs `fn` with the runless cap multiplied by `scale`. An eval execution runs
 * every case of its dataset under one cap, so it scales the cap by its case
 * count: the setting then reads as a per-case allowance, and a large dataset is
 * not held to the budget of a small one.
 */
export function withRunlessCapScale<T>(scale: number, fn: () => Promise<T>): Promise<T> {
  return capScale.run(Math.max(1, Math.floor(scale)), fn);
}

export function _resetRunlessBudgetForTests(): void {
  unpersisted.clear();
}

interface RunlessState {
  usedInput: number;
  usedOutput: number;
  maxInput: number;
  maxOutput: number;
}

/**
 * The execution's spend and caps, or null when it is not runless (it has a
 * `WorkflowRun`, so its own budget applies) or the state cannot be read — a
 * failed read never fails a call that has been paid for.
 */
async function runlessState(
  workflowId: string,
  temporalRunId: string,
  pending: { input: number; output: number }
): Promise<RunlessState | null> {
  const key = keyOf(workflowId, temporalRunId);
  let added = false;
  try {
    const run = await prisma.workflowRun.findUnique({
      select: { id: true },
      where: { workflowId },
    });
    if (run) {
      return null;
    }
    added = true;
    if (pending.input > 0 || pending.output > 0) {
      addUnpersisted(key, pending.input, pending.output);
    }
    const [persisted, owner] = await Promise.all([
      runUnscoped('scoped by one workflow execution', ['AgentTrace'], () =>
        prisma.agentTrace.aggregate({
          _sum: { inputTokens: true, outputTokens: true },
          where: {
            agentKey: { not: EMBEDDING_AGENT_KEY },
            temporalRunId,
            type: 'llm_response',
            workflowId,
          },
        })
      ),
      currentSpendOwner(),
    ]);
    const limits = await resolveSettings(
      ['workflow.runlessMaxInputTokens', 'workflow.runlessMaxOutputTokens'],
      owner
    );
    const inFlight = unpersisted.get(key) ?? { input: 0, output: 0 };
    const scale = capScale.getStore() ?? 1;
    return {
      maxInput: limits['workflow.runlessMaxInputTokens'] * scale,
      maxOutput: limits['workflow.runlessMaxOutputTokens'] * scale,
      usedInput: (persisted._sum.inputTokens ?? 0) + inFlight.input,
      usedOutput: (persisted._sum.outputTokens ?? 0) + inFlight.output,
    };
  } catch (err) {
    // A failed run lookup still adds the call: `takePersistingUsage` subtracts
    // the activity's full token totals when its rows are written, so tokens
    // never added here would be taken from another activity's in-flight spend
    // on this execution (the other arm of an eval case). Should the execution
    // have a run after all, that subtraction removes them again.
    if (!added && (pending.input > 0 || pending.output > 0)) {
      addUnpersisted(key, pending.input, pending.output);
    }
    logWarn('Runless workflow budget unreadable — the call is not capped', {
      error: err instanceof Error ? err.message : String(err),
      workflowId,
    });
    return null;
  }
}

function exceeded(
  state: RunlessState,
  label: string,
  attribution?: LlmAttribution
): ApplicationFailure {
  return ApplicationFailure.nonRetryable(
    `Runless workflow budget ${attribution ? 'exceeded by' : 'already exhausted before'} ${label}: ` +
      `${state.usedInput}/${state.maxInput} input tokens, ` +
      `${state.usedOutput}/${state.maxOutput} output tokens used`,
    'BUDGET_EXCEEDED',
    // The paid call's attribution rides along so the caller's trace row is
    // priced (see failedCallAttribution), as on the tier check.
    { attribution, label, runless: true, usedInput: state.usedInput, usedOutput: state.usedOutput }
  );
}

/**
 * Debit a call to a runless execution and throw `BUDGET_EXCEEDED` once it is
 * over its cap. A no-op for any workflow with a run, and outside an activity.
 */
export async function recordRunlessUsage(
  workflowId: string,
  temporalRunId: string | null,
  attribution: LlmAttribution,
  label: string
): Promise<void> {
  if (!temporalRunId) {
    return;
  }
  const state = await runlessState(workflowId, temporalRunId, {
    input: attribution.inputTokens,
    output: attribution.outputTokens,
  });
  if (state && (state.usedInput > state.maxInput || state.usedOutput > state.maxOutput)) {
    throw exceeded(state, label, attribution);
  }
}

/** Refuse a call for a runless execution that has already spent its cap. */
export async function assertRunlessBudgetAvailable(
  workflowId: string,
  temporalRunId: string | null,
  label: string
): Promise<void> {
  if (!temporalRunId) {
    return;
  }
  const state = await runlessState(workflowId, temporalRunId, { input: 0, output: 0 });
  // `>=` before a call, `>` after one — the same pairing as the tier checks.
  if (state && (state.usedInput >= state.maxInput || state.usedOutput >= state.maxOutput)) {
    throw exceeded(state, label);
  }
}
