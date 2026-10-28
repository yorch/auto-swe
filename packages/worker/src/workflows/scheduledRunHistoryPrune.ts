import { proxyActivities } from '@temporalio/workflow';
import type { pruneRunHistory as pruneRunHistoryType } from '../activities/pruneRunHistory.js';
import { RETRY_SCHEDULED, T_2M, T_10M } from './proxyOptions.js';

const { pruneRunHistory } = proxyActivities<{
  pruneRunHistory: typeof pruneRunHistoryType;
}>({
  // The activity heartbeats before each batch and artifact, so an attempt that outlives its
  // timeout (or is cancelled) is told to stop instead of running beside its retry.
  heartbeatTimeout: T_2M,
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_10M,
});

export type ScheduledRunHistoryPruneResult = Awaited<ReturnType<typeof pruneRunHistoryType>>;

/**
 * Delete finished runs past `workflow.runRetentionDays` (when set) on the cadence set by
 * `RUN_HISTORY_PRUNE_ENABLED` and `RUN_HISTORY_PRUNE_CRON`.
 */
export async function ScheduledRunHistoryPruneWorkflow(): Promise<ScheduledRunHistoryPruneResult> {
  return pruneRunHistory();
}
