import type {
  ScheduledRevalidationInput,
  ScheduledRevalidationResult,
} from '@auto-swe/shared/types/workflow';
import { patched, proxyActivities } from '@temporalio/workflow';
import type { screenDatasetCasesActivity } from '../activities/evalFlakeScreen.js';
import type { revalidateDatasetActivity } from '../activities/evalRevalidate.js';
import type { getDatasetsForRevalidation } from '../activities/getDatasetsForRevalidation.js';
import { SCREEN_ACTIVITY_OPTIONS } from './evalScreen.js';
import { RETRY_SCHEDULED, T_2_MINUTES, T_30_MINUTES } from './proxyOptions.js';

const { getDatasetsForRevalidation: getDatasets } = proxyActivities<{
  getDatasetsForRevalidation: typeof getDatasetsForRevalidation;
}>({
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_2_MINUTES,
});

const { revalidateDatasetActivity: revalidateDataset } = proxyActivities<{
  revalidateDatasetActivity: typeof revalidateDatasetActivity;
}>({
  retry: RETRY_SCHEDULED,
  // Long timeout — re-validation clones repos and runs Docker gates per case.
  startToCloseTimeout: T_30_MINUTES,
});

const { screenDatasetCasesActivity: screenDatasetCases } = proxyActivities<{
  screenDatasetCasesActivity: typeof screenDatasetCasesActivity;
}>(SCREEN_ACTIVITY_OPTIONS);

/**
 * Gates the flake-screen sweep, so a sweep that started before it existed
 * replays without the screen activities its history never scheduled.
 */
export const FLAKE_SCREEN_SWEEP_PATCH = 'eval-flake-screen-sweep';

interface DatasetOutcome {
  caseResult: ScheduledRevalidationResult['caseResults'][number];
  screenResult?: ScheduledRevalidationResult['screenResults'][number];
}

/**
 * Fan-out re-validation workflow triggered by the Temporal Schedule.
 * Fetches all datasets (optionally filtered by slug) and runs
 * revalidateDatasetActivity for each as an independent activity call, so
 * failures are isolated per dataset. After a dataset's re-validation it
 * flake-screens the dataset's never-screened cases, so a case added while
 * Temporal was unavailable, or whose screen hit an infrastructure error, is
 * screened on the next sweep.
 */
export async function ScheduledRevalidationWorkflow(
  input: ScheduledRevalidationInput
): Promise<ScheduledRevalidationResult> {
  const screen = patched(FLAKE_SCREEN_SWEEP_PATCH);
  const datasets = await getDatasets(input);

  // Run all dataset re-validations concurrently. A failure in one dataset
  // does not abort the others — each error is captured in the result.
  const results = await Promise.all(
    datasets.map(async (d): Promise<DatasetOutcome> => {
      let caseResult: DatasetOutcome['caseResult'];
      try {
        const result = await revalidateDataset(d.datasetId);
        caseResult = { datasetId: d.datasetId, result };
      } catch (err) {
        caseResult = {
          datasetId: d.datasetId,
          result: { error: err instanceof Error ? err.message : String(err) },
        };
      }
      if (!screen) {
        return { caseResult };
      }
      // After re-validation, so a case it just quarantined is not screened.
      try {
        const result = await screenDatasetCases(d.datasetId);
        return { caseResult, screenResult: { datasetId: d.datasetId, result } };
      } catch (err) {
        return {
          caseResult,
          screenResult: {
            datasetId: d.datasetId,
            result: { error: err instanceof Error ? err.message : String(err) },
          },
        };
      }
    })
  );

  return {
    caseResults: results.map((r) => r.caseResult),
    datasetsProcessed: datasets.length,
    screenResults: results.flatMap((r) => (r.screenResult ? [r.screenResult] : [])),
  };
}
