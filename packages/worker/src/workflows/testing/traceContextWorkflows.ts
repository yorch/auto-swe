/**
 * Workflow bundle for `traceContext.workflow.test.ts`: a parent that runs an
 * activity and a child workflow that runs one too, so the test can see the
 * starter's trace context reach both hops. Test-only — not part of the
 * worker's `index.ts` barrel.
 */
import {
  condition,
  defineSignal,
  executeChild,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';

export * from './traceContextFailWorkflows.js';

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

const poke = defineSignal('poke');

/** Waits for a signal, then runs a child whose activity should still link to it. */
export async function TraceSignalParentWorkflow(): Promise<void> {
  let poked = false;
  setHandler(poke, () => {
    poked = true;
  });
  await condition(() => poked);
  await executeChild(TraceChildWorkflow, { workflowId: `${workflowInfo().workflowId}-child` });
}

/** Waits for a signal, then runs an activity — the shape of an approval gate. */
export async function TraceSignalWorkflow(): Promise<void> {
  let poked = false;
  setHandler(poke, () => {
    poked = true;
  });
  await probe('before');
  await condition(() => poked);
  await probe('after');
}
