import type {
  ScheduledRevalidationInput,
  ScheduledRevalidationResult,
} from '@auto-swe/shared/types/workflow';
import { proxyActivities } from '@temporalio/workflow';
import type { revalidateDatasetActivity } from '../activities/evalRevalidate.js';
import type { getDatasetsForRevalidation } from '../activities/getDatasetsForRevalidation.js';
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

/**
 * Fan-out re-validation workflow triggered by the Temporal Schedule.
 * Fetches all datasets (optionally filtered by slug) and runs
 * revalidateDatasetActivity for each as an independent activity call, so
 * failures are isolated per dataset.
 */
export async function ScheduledRevalidationWorkflow(
  input: ScheduledRevalidationInput
): Promise<ScheduledRevalidationResult> {
  const datasets = await getDatasets(input);

  // Run all dataset re-validations concurrently. A failure in one dataset
  // does not abort the others — each error is captured in the result.
  const caseResults = await Promise.all(
    datasets.map(async (d) => {
      try {
        const result = await revalidateDataset(d.datasetId);
        return { datasetId: d.datasetId, result };
      } catch (err) {
        return {
          datasetId: d.datasetId,
          result: { error: err instanceof Error ? err.message : String(err) },
        };
      }
    })
  );

  return { caseResults, datasetsProcessed: datasets.length };
}
