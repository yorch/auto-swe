import { prisma } from '@auto-swe/shared/db';
import {
  type AgentRunSlot,
  type ClosedLedgerStatus,
  closeAgentRunLedgerRows,
  closedLedgerStatusFor,
  isWorkflowStatusFinished,
  loadAgentRunSlots,
  reconcileAgentRunSlots,
} from '@auto-swe/shared/lib/agentRunAdmission';
import { WorkflowNotFoundError } from '@temporalio/client';
import { logWarn } from './activityLog.js';
import { getTemporalClient } from './temporalClient.js';

/**
 * Whether the workflow is still executing in Temporal. `false` for a finished
 * execution and for one that does not exist; throws when Temporal cannot be
 * asked, so the caller keeps counting the row.
 */
export async function workflowIsRunning(workflowId: string): Promise<boolean> {
  try {
    const { status } = await getTemporalClient().workflow.getHandle(workflowId).describe();
    return !isWorkflowStatusFinished(status.name);
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) {
      return false;
    }
    throw err;
  }
}

/**
 * The ledger status a finished execution closes its row with, null while it
 * runs; `FAILED` for one that does not exist. Throws when Temporal cannot be asked.
 */
export async function workflowSettledStatus(
  workflowId: string
): Promise<ClosedLedgerStatus | null> {
  try {
    const { status } = await getTemporalClient().workflow.getHandle(workflowId).describe();
    return closedLedgerStatusFor(status.name);
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) {
      return 'FAILED';
    }
    throw err;
  }
}

/**
 * Which of `workflowIds` are stopped at a question and holding nothing: a run whose
 * activity returned a pause has released its containers and is waiting on a
 * PENDING input step the needs-input loop opened (`<key>:ask:<round>`).
 * Empty on a read failure, so a run that cannot be shown to wait keeps its slot.
 */
async function workflowIdsWaitingForInput(workflowIds: string[]): Promise<Set<string>> {
  if (workflowIds.length === 0) {
    return new Set();
  }
  try {
    const rows = await prisma.workflowHumanStep.findMany({
      select: { run: { select: { workflowId: true } } },
      where: {
        kind: 'INPUT',
        nodeId: { contains: ':ask:' },
        run: { workflowId: { in: workflowIds } },
        status: 'PENDING',
      },
    });
    return new Set(rows.map((r) => r.run.workflowId));
  } catch (err) {
    logWarn('could not tell which agent runs are waiting for input; they keep their slot', {
      err: err instanceof Error ? err.message : String(err),
    });
    return new Set();
  }
}

/**
 * The agent runs genuinely in flight: every non-terminal ledger row, minus those
 * whose workflow Temporal reports finished or gone (which are closed as a side
 * effect), and minus those paused at a question (they hold no container). `self` is
 * the caller and is never looked up or excluded. See
 * {@link reconcileAgentRunSlots} for the bounds and the fail-safe.
 */
export async function loadLiveAgentRunSlots(
  templateId: string,
  self: string
): Promise<AgentRunSlot[]> {
  const all = await loadAgentRunSlots(prisma, templateId);
  const waiting = await workflowIdsWaitingForInput(all.map((s) => s.workflowId));
  // `self` stays: the caller is the one being admitted.
  const held = all.filter((s) => s.workflowId === self || !waiting.has(s.workflowId));
  return reconcileAgentRunSlots(held, {
    close: closeAgentRunLedgerRows(prisma),
    isRunning: workflowIsRunning,
    onClosed: (ids) =>
      logWarn('closed agent run ledger rows whose workflow is no longer running', {
        workflowIds: ids,
      }),
    onUnreachable: (workflowId, err) =>
      logWarn('could not confirm an agent run is finished; it keeps its concurrency slot', {
        err: err instanceof Error ? err.message : String(err),
        workflowId,
      }),
    self,
  });
}
