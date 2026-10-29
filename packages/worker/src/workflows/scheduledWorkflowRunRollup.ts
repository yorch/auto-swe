import { proxyActivities } from '@temporalio/workflow';
import type { rollupWorkflowRuns as rollupWorkflowRunsType } from '../activities/rollupWorkflowRuns.js';
import { RETRY_SCHEDULED, T_10M, T_90M } from './proxyOptions.js';

const { rollupWorkflowRuns } = proxyActivities<{
  rollupWorkflowRuns: typeof rollupWorkflowRunsType;
}>({
  heartbeatTimeout: T_10M,
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_90M,
});

export type ScheduledWorkflowRunRollupResult = Awaited<ReturnType<typeof rollupWorkflowRunsType>>;

export async function ScheduledWorkflowRunRollupWorkflow(): Promise<ScheduledWorkflowRunRollupResult> {
  return rollupWorkflowRuns();
}
