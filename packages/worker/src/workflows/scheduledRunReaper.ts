import { proxyActivities } from '@temporalio/workflow';
import type { reapStrandedRuns as reapStrandedRunsType } from '../activities/reapStrandedRuns.js';
import { RETRY_SCHEDULED, T_10M } from './proxyOptions.js';

const { reapStrandedRuns } = proxyActivities<{
  reapStrandedRuns: typeof reapStrandedRunsType;
}>({
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_10M,
});

export type ScheduledRunReaperResult = Awaited<ReturnType<typeof reapStrandedRunsType>>;

/**
 * Finalize the runs whose workflow ended in Temporal without finalizing them,
 * on the cadence set by `RUN_REAPER_ENABLED` and `RUN_REAPER_CRON`. One
 * activity: the lookups are bounded and each failure leaves its run alone.
 */
export async function ScheduledRunReaperWorkflow(): Promise<ScheduledRunReaperResult> {
  return reapStrandedRuns();
}
