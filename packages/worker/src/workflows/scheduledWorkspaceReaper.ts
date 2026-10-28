import { proxyActivities } from '@temporalio/workflow';
import type { reapOrphanedWorkspaces as reapOrphanedWorkspacesType } from '../activities/reapOrphanedWorkspaces.js';
import { RETRY_SCHEDULED, T_30M } from './proxyOptions.js';

// The worst case is one listing (60 s) plus `MAX_REAPED_PER_SWEEP` (25) removals,
// each bounded at 60 s by its driver: about 26 of this timeout's 30 minutes.
const { reapOrphanedWorkspaces } = proxyActivities<{
  reapOrphanedWorkspaces: typeof reapOrphanedWorkspacesType;
}>({
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_30M,
});

export type ScheduledWorkspaceReaperResult = Awaited<ReturnType<typeof reapOrphanedWorkspacesType>>;

/**
 * Remove the workspace containers and pods whose activity is long gone, on the
 * cadence set by `WORKSPACE_REAPER_ENABLED` and `WORKSPACE_REAPER_CRON`. One
 * activity that never throws: each failure is logged and left for the next sweep.
 */
export async function ScheduledWorkspaceReaperWorkflow(): Promise<ScheduledWorkspaceReaperResult> {
  return reapOrphanedWorkspaces();
}
