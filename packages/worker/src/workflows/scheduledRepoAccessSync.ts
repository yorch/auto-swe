import { proxyActivities } from '@temporalio/workflow';
import type { syncRepoAccess as syncRepoAccessType } from '../activities/syncRepoAccess.js';
import { RETRY_SCHEDULED, T_30_MINUTES } from './proxyOptions.js';

const { syncRepoAccess } = proxyActivities<{
  syncRepoAccess: typeof syncRepoAccessType;
}>({
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_30_MINUTES,
});

export type ScheduledRepoAccessSyncResult = Awaited<ReturnType<typeof syncRepoAccessType>>;

/**
 * Refresh the cached GitHub permission answers on the configured schedule.
 *
 * Deliberately a single activity call rather than a per-repository fan-out like
 * the dependency scan. The sweep's cost is GitHub API quota against one shared
 * credential, so running the repositories concurrently would spend the same
 * quota in a burst and make a rate limit more likely, not less. Its inner loop
 * already survives a per-pair failure by leaving that pair's previous answer in
 * place, which is what the fan-out buys elsewhere.
 *
 * Webhook invalidation is what keeps revocation fast; this bounds how long a
 * missed webhook can hide one.
 */
export async function ScheduledRepoAccessSyncWorkflow(): Promise<ScheduledRepoAccessSyncResult> {
  return syncRepoAccess({});
}
