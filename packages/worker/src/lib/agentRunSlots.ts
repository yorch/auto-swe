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
 * The agent runs genuinely in flight: every non-terminal ledger row, minus those
 * whose workflow Temporal reports finished or gone (which are closed as a side
 * effect). `self` is the caller and is never looked up. See
 * {@link reconcileAgentRunSlots} for the bounds and the fail-safe.
 */
export async function loadLiveAgentRunSlots(
  templateId: string,
  self: string
): Promise<AgentRunSlot[]> {
  return reconcileAgentRunSlots(await loadAgentRunSlots(prisma, templateId), {
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
