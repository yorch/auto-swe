/**
 * Workflow bundle for the workflow-span tests: one that ends in a failure after
 * running an activity, one that continues as new once, one cancelled mid-activity,
 * and one that throws a plain error. Test-only.
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
const { hold } = proxyActivities<{ hold(): Promise<void> }>({ startToCloseTimeout: '30s' });

/** Waits on a slow activity, so a cancel arrives while the run is awaiting it. */
export async function TraceCancelWorkflow(): Promise<void> {
  await hold();
}

/** A plain error fails the workflow task, not the workflow: Temporal retries it. */
export async function TracePlainErrorWorkflow(): Promise<void> {
  throw new Error('plain');
}

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
