/**
 * Workflow bundle for `epicOrchestrator.workflow.test.ts`: the real epic
 * orchestrator, plus a stand-in `RunnableWorkflow` child that runs until it is
 * cancelled and reports the cancellation through an activity. Test-only — not
 * part of the worker's `index.ts` barrel.
 */
import {
  CancellationScope,
  condition,
  isCancellation,
  proxyActivities,
  workflowInfo,
} from '@temporalio/workflow';

export { EpicOrchestratorWorkflow, epicCancelSignal } from '../epicOrchestrator.js';

const { recordChildCancelled } = proxyActivities<{
  recordChildCancelled(workflowId: string): Promise<void>;
}>({ startToCloseTimeout: '10s' });

export async function RunnableWorkflow(): Promise<{ status: 'SUCCESS' }> {
  try {
    await condition(() => false);
    return { status: 'SUCCESS' };
  } catch (err) {
    if (isCancellation(err)) {
      await CancellationScope.nonCancellable(() => recordChildCancelled(workflowInfo().workflowId));
    }
    throw err;
  }
}
