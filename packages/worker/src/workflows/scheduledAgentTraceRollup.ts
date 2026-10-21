import { proxyActivities } from '@temporalio/workflow';
import type { rollupAgentTraceUsage as rollupAgentTraceUsageType } from '../activities/rollupAgentTraceUsage.js';
import { RETRY_SCHEDULED, T_10M, T_90M } from './proxyOptions.js';

const { rollupAgentTraceUsage } = proxyActivities<{
  rollupAgentTraceUsage: typeof rollupAgentTraceUsageType;
}>({
  // 2 recomputed + 10 backfilled days at the 5-minute transaction ceiling is an hour, and the rest is headroom for the
  // reads around each day; the
  // heartbeat (between days) must outlast one transaction.
  heartbeatTimeout: T_10M,
  retry: RETRY_SCHEDULED,
  startToCloseTimeout: T_90M,
});

export type ScheduledAgentTraceRollupResult = Awaited<ReturnType<typeof rollupAgentTraceUsageType>>;

/**
 * Sum the last two completed UTC days of LLM traces into `agent_trace_daily_usage` (and, when
 * `AGENT_TRACE_ROLLUP_BACKFILL_DAYS` is set, older days that have no rollup yet), on the cadence
 * set by `AGENT_TRACE_ROLLUP_ENABLED` and `AGENT_TRACE_ROLLUP_CRON`.
 */
export async function ScheduledAgentTraceRollupWorkflow(): Promise<ScheduledAgentTraceRollupResult> {
  return rollupAgentTraceUsage();
}
