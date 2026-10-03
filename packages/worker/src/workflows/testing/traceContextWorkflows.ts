/**
 * Workflow bundle for `traceContext.workflow.test.ts`: a parent that runs an
 * activity and a child workflow that runs one too, so the test can see the
 * starter's trace context reach both hops. Test-only — not part of the
 * worker's `index.ts` barrel.
 */
import { executeChild, proxyActivities, workflowInfo } from '@temporalio/workflow';

const { probe } = proxyActivities<{ probe(from: string): Promise<void> }>({
  startToCloseTimeout: '10s',
});

export async function TraceChildWorkflow(): Promise<void> {
  await probe('child');
}

export async function TraceParentWorkflow(): Promise<void> {
  await probe('parent');
  await executeChild(TraceChildWorkflow, { workflowId: `${workflowInfo().workflowId}-child` });
}
