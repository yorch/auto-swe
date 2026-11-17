import { proxyActivities } from '@temporalio/workflow';
import type { syncMarketplaces as syncMarketplacesType } from '../activities/syncMarketplaces.js';
import { RETRY_SCHEDULED, T_10M } from './proxyOptions.js';

const { syncMarketplaces } = proxyActivities<{
  syncMarketplaces: typeof syncMarketplacesType;
}>({
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_10M,
});

export type ScheduledMarketplaceSyncResult = Awaited<ReturnType<typeof syncMarketplacesType>>;

/**
 * Check each tracked plugin marketplace for a newer commit, on the cadence set by
 * `MARKETPLACE_SYNC_ENABLED` and `MARKETPLACE_SYNC_CRON`. One activity; it only flags updates: a
 * pin moves, and a plugin is approved, only when an administrator does it.
 */
export async function ScheduledMarketplaceSyncWorkflow(): Promise<ScheduledMarketplaceSyncResult> {
  return syncMarketplaces();
}
