import type { ScheduledEvalInput } from '@auto-swe/shared/types/workflow';
import { log, proxyActivities } from '@temporalio/workflow';
import type { runEvalHarnessActivity as runEvalHarnessActivityType } from '../activities/evalHarness.js';
import type { prepareScheduledEvalRun as prepareScheduledEvalRunType } from '../activities/prepareScheduledEvalRun.js';

/**
 * Scheduled eval-regression workflow (evals P1) — the platform-native
 * replacement for the old `evals-nightly.yml` GitHub Action.
 *
 * Fired by a single named Temporal Schedule (see the gateway `temporal` plugin),
 * exactly like `ScheduledConsolidationWorkflow`. On each fire it resolves the
 * configured benchmark dataset by slug, creates a fresh `EvalRun` row, and runs
 * the offline harness — which scores the candidate vs the baseline and writes
 * the paired, error-barred regression verdict. A missing dataset is a no-op
 * (logged), so the schedule is harmless before the benchmark is seeded.
 */
const { prepareScheduledEvalRun } = proxyActivities<{
  prepareScheduledEvalRun: typeof prepareScheduledEvalRunType;
}>({
  retry: { maximumAttempts: 3 },
  startToCloseTimeout: '2 minutes',
});

const { runEvalHarnessActivity } = proxyActivities<{
  runEvalHarnessActivity: typeof runEvalHarnessActivityType;
}>({
  heartbeatTimeout: '5 minutes',
  // A full benchmark is many multi-minute Docker + LLM cases.
  startToCloseTimeout: '4 hours',
});

export async function ScheduledEvalWorkflow(input: ScheduledEvalInput): Promise<void> {
  const prepared = await prepareScheduledEvalRun(input);
  if (!prepared) {
    log.warn('scheduled eval skipped: dataset not found', { datasetSlug: input.datasetSlug });
    return;
  }
  await runEvalHarnessActivity(prepared);
}
