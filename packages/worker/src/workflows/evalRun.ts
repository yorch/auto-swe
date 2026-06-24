import { proxyActivities } from '@temporalio/workflow';
import type { runEvalHarnessActivity as runEvalHarnessActivityType } from '../activities/evalHarness.js';

/**
 * Durable offline-eval harness workflow (evals P1/WS4; docs/evals-p1.md).
 *
 * A thin durable wrapper: it proxies the `runEvalHarnessActivity`, which does
 * the per-case Docker work (provision a fixture at its pinned SHA, run the
 * golden test) and writes the EvalRun verdict. Kept in a workflow so a
 * multi-case run is observable + resumable in the Temporal UI; all I/O is in
 * the activity (V8-isolate rule).
 */
const { runEvalHarnessActivity } = proxyActivities<{
  runEvalHarnessActivity: typeof runEvalHarnessActivityType;
}>({
  heartbeatTimeout: '5 minutes',
  // A full benchmark is many multi-minute Docker + LLM cases.
  startToCloseTimeout: '4 hours',
});

export interface EvalRunWorkflowInput {
  evalRunId: string;
  datasetId: string;
  candidateRef: string;
  baselineRef: string;
}

export async function EvalRunWorkflow(input: EvalRunWorkflowInput): Promise<void> {
  await runEvalHarnessActivity(input);
}
