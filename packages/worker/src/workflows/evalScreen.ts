import type { EvalScreenInput, FlakeScreenResult } from '@auto-swe/shared/types/workflow';
import { proxyActivities } from '@temporalio/workflow';
import type {
  countUnscreenedCasesActivity,
  screenDatasetCasesActivity,
} from '../activities/evalFlakeScreen.js';
import { RETRY_SCHEDULED, T_2_MINUTES, T_4_HOURS, T_5_MINUTES } from './proxyOptions.js';

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

const { countUnscreenedCasesActivity: countUnscreenedCases } = proxyActivities<{
  countUnscreenedCasesActivity: typeof countUnscreenedCasesActivity;
}>({ retry: RETRY_SCHEDULED, startToCloseTimeout: T_2_MINUTES });

/** Screens per run. A bound, so a dataset reset over and over cannot hold one run forever. */
const MAX_SCREEN_ROUNDS = 5;

/**
 * Flake-screen one dataset's never-screened cases. Runs under one id per
 * dataset (`evalScreenWorkflowId`), started — or joined, while one runs — by
 * the gateway when a dataset is created with cases, by an eval run that finds
 * never-screened cases, and by an admin re-screen. The re-validation sweep
 * screens whatever these miss (Temporal unavailable, an infrastructure error).
 *
 * A start can join a screen whose activity has already made its last load, so
 * after each screen the workflow counts the cases still waiting and screens
 * again while any are. A case that hit an infrastructure error in this run is
 * left for the next one, not retried at once.
 */
export async function EvalScreenWorkflow(input: EvalScreenInput): Promise<FlakeScreenResult> {
  const total: FlakeScreenResult = {
    erroredCaseIds: [],
    failedCaseIds: [],
    passed: 0,
    screened: 0,
  };
  for (let round = 0; round < MAX_SCREEN_ROUNDS; round += 1) {
    const r = await screenDatasetCases(input.datasetId, total.erroredCaseIds);
    total.screened += r.screened;
    total.passed += r.passed;
    total.failedCaseIds.push(...r.failedCaseIds);
    for (const id of r.erroredCaseIds) {
      if (!total.erroredCaseIds.includes(id)) {
        total.erroredCaseIds.push(id);
      }
    }
    if ((await countUnscreenedCases(input.datasetId, total.erroredCaseIds)) === 0) {
      break;
    }
  }
  return total;
}
