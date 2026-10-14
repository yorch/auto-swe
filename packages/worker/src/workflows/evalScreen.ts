import type { EvalScreenInput, FlakeScreenResult } from '@auto-swe/shared/types/workflow';
import { proxyActivities } from '@temporalio/workflow';
import type { screenDatasetCasesActivity } from '../activities/evalFlakeScreen.js';
import { RETRY_SCHEDULED, T_4_HOURS } from './proxyOptions.js';

/**
 * Activity options shared by the on-create screen and the scheduled sweep
 * (`scheduledRevalidation.ts`). Retrying is safe: a recorded case is no longer
 * loaded, so a retry resumes with the cases still unscreened.
 */
export const SCREEN_ACTIVITY_OPTIONS = {
  retry: RETRY_SCHEDULED,
  // k reference runs per case, each a clone plus a Docker gate.
  startToCloseTimeout: T_4_HOURS,
};

const { screenDatasetCasesActivity: screenDatasetCases } = proxyActivities<{
  screenDatasetCasesActivity: typeof screenDatasetCasesActivity;
}>(SCREEN_ACTIVITY_OPTIONS);

/**
 * Flake-screen one dataset's never-screened cases. Started by the gateway when
 * a dataset is created with cases; the re-validation sweep screens whatever
 * this misses (Temporal unavailable at creation, an infrastructure error).
 */
export async function EvalScreenWorkflow(input: EvalScreenInput): Promise<FlakeScreenResult> {
  return screenDatasetCases(input.datasetId);
}
