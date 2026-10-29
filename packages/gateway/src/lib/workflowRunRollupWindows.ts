import type { PrismaClient } from '@auto-swe/shared';
import { DAY_MS } from '@auto-swe/shared/lib/agentTraceRollup';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { WORKFLOW_RUN_ROLLUP_RECOMPUTE_DAYS } from '@auto-swe/shared/workflow';
import type { Range } from './usageWindows.js';

export function workflowRunRollupHorizonMs(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS) * DAY_MS - WORKFLOW_RUN_ROLLUP_RECOMPUTE_DAYS * DAY_MS;
}

export async function coveredWorkflowRunRollupDays(
  prisma: Pick<PrismaClient, 'workflowRunDailyRollup'>,
  startMs: number,
  endMs: number,
  nowMs: number
): Promise<Set<number>> {
  const horizon = workflowRunRollupHorizonMs(nowMs);
  if (startMs >= horizon) {
    return new Set();
  }
  const rows = await runUnscoped(
    'which UTC days the workflow run rollup has built, without exposing tenant data',
    ['WorkflowRunDailyRollup'],
    () =>
      prisma.workflowRunDailyRollup.groupBy({
        by: ['day'],
        where: {
          day: { gte: new Date(startMs), lt: new Date(Math.min(endMs, horizon)) },
        },
      })
  );
  return new Set(rows.map((row) => row.day.getTime()));
}

export function startedAtWhere(
  ranges: readonly Range[]
): { startedAt: Range } | { OR: { startedAt: Range }[] } {
  const [only] = ranges;
  return ranges.length === 1 && only
    ? { startedAt: only }
    : { OR: ranges.map((range) => ({ startedAt: range })) };
}
