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
 * their activity persists, and a failed trace write loses its rows from the sum.
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

/** An activity persisted rows carrying these tokens; they are now in the trace sum. */
export function notePersistedUsage(
  workflowId: string,
  temporalRunId: string | null,
  input: number,
  output: number
): void {
  if (!temporalRunId) {
    return;
  }
  const key = keyOf(workflowId, temporalRunId);
  const entry = unpersisted.get(key);
  if (!entry) {
    return;
  }
  entry.input = Math.max(0, entry.input - input);
  entry.output = Math.max(0, entry.output - output);
  if (entry.input === 0 && entry.output === 0) {
    unpersisted.delete(key);
  }
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
  try {
    const run = await prisma.workflowRun.findUnique({
      select: { id: true },
      where: { workflowId },
    });
    if (run) {
      return null;
    }
    const key = keyOf(workflowId, temporalRunId);
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
    return {
      maxInput: limits['workflow.runlessMaxInputTokens'],
      maxOutput: limits['workflow.runlessMaxOutputTokens'],
      usedInput: (persisted._sum.inputTokens ?? 0) + inFlight.input,
      usedOutput: (persisted._sum.outputTokens ?? 0) + inFlight.output,
    };
  } catch (err) {
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
