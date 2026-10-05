/**
 * Workflow bundle for the workflow-span tests: one that ends in a failure after
 * running an activity, and one that continues as new once. Test-only.
 */
import {
  ApplicationFailure,
  continueAsNew,
  proxyActivities,
  workflowInfo,
} from '@temporalio/workflow';

const { probe } = proxyActivities<{ probe(from: string): Promise<void> }>({
  startToCloseTimeout: '10s',
});

export async function TraceFailingWorkflow(): Promise<void> {
  await probe('failing');
  throw ApplicationFailure.nonRetryable('boom');
}

/** Runs an activity, continues as new once, then runs another in the second run. */
export async function TraceContinueWorkflow(generation = 0): Promise<void> {
  await probe(`run-${workflowInfo().runId}`);
  if (generation === 0) {
    await continueAsNew<typeof TraceContinueWorkflow>(1);
  }
}
