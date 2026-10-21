import { proxyActivities } from '@temporalio/workflow';
import type { pruneAuditAndActivity as pruneAuditAndActivityType } from '../activities/pruneAuditAndActivity.js';
import { RETRY_SCHEDULED, T_10M } from './proxyOptions.js';

const { pruneAuditAndActivity } = proxyActivities<{
  pruneAuditAndActivity: typeof pruneAuditAndActivityType;
}>({
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_10M,
});

export type ScheduledAuditActivityPruneResult = Awaited<
  ReturnType<typeof pruneAuditAndActivityType>
>;

/**
 * Delete audit-log rows past `audit.configLogRetentionDays` (when set) and user-activity events
 * past `analytics.activityRetentionDays`, on the cadence set by `AUDIT_ACTIVITY_PRUNE_ENABLED`
 * and `AUDIT_ACTIVITY_PRUNE_CRON`.
 */
export async function ScheduledAuditActivityPruneWorkflow(): Promise<ScheduledAuditActivityPruneResult> {
  return pruneAuditAndActivity();
}
