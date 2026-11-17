import { proxyActivities } from '@temporalio/workflow';
import type { sweepRunPlans as sweepRunPlansType } from '../activities/sweepRunPlans.js';
import { RETRY_SCHEDULED, T_10M } from './proxyOptions.js';

const { sweepRunPlans } = proxyActivities<{ sweepRunPlans: typeof sweepRunPlansType }>({
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_10M,
});

export type ScheduledRunPlanSweepResult = Awaited<ReturnType<typeof sweepRunPlansType>>;

/**
 * Expire run plans nobody approved in time and delete old expired and rejected ones, on the
 * cadence set by `RUN_PLAN_SWEEP_ENABLED` and `RUN_PLAN_SWEEP_CRON`. A Temporal Schedule starts one
 * at a time, so it is safe with any number of gateway and worker replicas.
 */
export async function ScheduledRunPlanSweepWorkflow(): Promise<ScheduledRunPlanSweepResult> {
  return sweepRunPlans();
}
