/**
 * Workflow bundle for `epicOrchestrator.workflow.test.ts`: the real epic
 * orchestrator, plus a stand-in `RunnableWorkflow` child. Its behaviour is
 * chosen by the `templateId` the fake `resolveTemplateForRepo` returns:
 *  - `sleep:<ms>:<status>` — sleep, report completion, return `<status>`;
 *  - anything else — run until cancelled and report the cancellation.
 * Test-only — not part of the worker's `index.ts` barrel.
 */
import {
  CancellationScope,
  condition,
  isCancellation,
  proxyActivities,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';

export { EpicOrchestratorWorkflow, epicCancelSignal } from '../epicOrchestrator.js';

const { recordChildCancelled, recordChildFinished } = proxyActivities<{
  recordChildCancelled(workflowId: string): Promise<void>;
  recordChildFinished(workflowId: string): Promise<void>;
}>({ startToCloseTimeout: '10s' });

export async function RunnableWorkflow(input: {
  templateId: string;
}): Promise<{ lessonsGenerated: []; status: string; totalCIRetries: 0; totalReviewRetries: 0 }> {
  const scripted = /^sleep:(\d+):(\w+)$/.exec(input.templateId);
  if (scripted) {
    await sleep(Number(scripted[1]));
    await recordChildFinished(workflowInfo().workflowId);
    return { lessonsGenerated: [], status: scripted[2], totalCIRetries: 0, totalReviewRetries: 0 };
  }
  try {
    await condition(() => false);
    return { lessonsGenerated: [], status: 'SUCCESS', totalCIRetries: 0, totalReviewRetries: 0 };
  } catch (err) {
    if (isCancellation(err)) {
      await CancellationScope.nonCancellable(() => recordChildCancelled(workflowInfo().workflowId));
    }
    throw err;
  }
}
