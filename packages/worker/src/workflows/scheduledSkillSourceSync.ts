import { proxyActivities } from '@temporalio/workflow';
import type { syncSkillSources as syncSkillSourcesType } from '../activities/syncSkillSources.js';
import { RETRY_SCHEDULED, T_10M } from './proxyOptions.js';

const { syncSkillSources } = proxyActivities<{
  syncSkillSources: typeof syncSkillSourcesType;
}>({
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_10M,
});

export type ScheduledSkillSourceSyncResult = Awaited<ReturnType<typeof syncSkillSourcesType>>;

/**
 * Check each tracked skill source for a newer commit, on the cadence set by
 * `SKILL_SOURCE_SYNC_ENABLED` and `SKILL_SOURCE_SYNC_CRON`. One activity; it
 * only flags updates — skills change when an admin accepts a reviewed diff.
 */
export async function ScheduledSkillSourceSyncWorkflow(): Promise<ScheduledSkillSourceSyncResult> {
  return syncSkillSources();
}
