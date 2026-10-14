import type { EvalScreenInput, FlakeScreenResult } from '@auto-swe/shared/types/workflow';
import { proxyActivities } from '@temporalio/workflow';
import type { screenDatasetCasesActivity } from '../activities/evalFlakeScreen.js';
import { RETRY_SCHEDULED, T_4_HOURS, T_5_MINUTES } from './proxyOptions.js';

/**
 * Activity options shared by the on-create screen and the scheduled sweep
 * (`scheduledRevalidation.ts`). Retrying is safe: a recorded case is no longer
 * loaded, so a retry resumes with the cases still unscreened.
 */
export const SCREEN_ACTIVITY_OPTIONS = {
  // The activity heartbeats after every reference run and while one runs, so a
  // worker that died mid-screen is noticed in minutes, not after the 4-hour cap.
  heartbeatTimeout: T_5_MINUTES,
  retry: RETRY_SCHEDULED,
  // k reference runs per case, each a clone plus a Docker gate.
  startToCloseTimeout: T_4_HOURS,
};

const { screenDatasetCasesActivity: screenDatasetCases } = proxyActivities<{
  screenDatasetCasesActivity: typeof screenDatasetCasesActivity;
}>(SCREEN_ACTIVITY_OPTIONS);

/**
 * Flake-screen one dataset's never-screened cases. Runs under one id per
 * dataset (`evalScreenWorkflowId`), started — or joined, while one runs — by
 * the gateway when a dataset is created with cases, by an eval run that finds
 * never-screened cases, and by an admin re-screen. The re-validation sweep
 * screens whatever these miss (Temporal unavailable, an infrastructure error).
 */
export async function EvalScreenWorkflow(input: EvalScreenInput): Promise<FlakeScreenResult> {
  return screenDatasetCases(input.datasetId);
}
