import type { PrismaClient } from '@auto-swe/shared';
import { DAY_MS } from '@auto-swe/shared/lib/agentTraceRollup';
import { resolveScheduledSweeps } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { WORKFLOW_RUN_ROLLUP_BUCKET_VERSION } from '@auto-swe/shared/workflow';
import type { Range } from './usageWindows.js';

export function workflowRunRollupHorizonMs(nowMs: number): number {
  const recomputeDays = resolveScheduledSweeps().workflowRunRollup.recomputeDays;
  return Math.floor(nowMs / DAY_MS) * DAY_MS - recomputeDays * DAY_MS;
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
          bucketVersion: WORKFLOW_RUN_ROLLUP_BUCKET_VERSION,
          day: { gte: new Date(startMs), lt: new Date(Math.min(endMs, horizon)) },
        },
      })
  );
  return new Set(rows.map((row) => row.day.getTime()));
}

export async function coveredHumanStepRollupDays(
  prisma: Pick<PrismaClient, 'humanStepDailyRollup'>,
  startMs: number,
  endMs: number,
  nowMs: number
): Promise<Set<number>> {
  const horizon = workflowRunRollupHorizonMs(nowMs);
  if (startMs >= horizon) {
    return new Set();
  }
  const rows = await runUnscoped(
    'which UTC days the human-step rollup has built, without exposing tenant data',
    ['HumanStepDailyRollup'],
    () =>
      prisma.humanStepDailyRollup.groupBy({
        by: ['day'],
        where: {
          bucketVersion: WORKFLOW_RUN_ROLLUP_BUCKET_VERSION,
          day: { gte: new Date(startMs), lt: new Date(Math.min(endMs, horizon)) },
        },
      })
  );
  return new Set(rows.map((row) => row.day.getTime()));
}

export async function coveredReviewVerdictRollupDays(
  prisma: Pick<PrismaClient, 'reviewVerdictDailyRollup'>,
  startMs: number,
  endMs: number,
  nowMs: number
): Promise<Set<number>> {
  const horizon = workflowRunRollupHorizonMs(nowMs);
  if (startMs >= horizon) {
    return new Set();
  }
  const rows = await runUnscoped(
    'which UTC days the review-verdict rollup has built, without exposing tenant data',
    ['ReviewVerdictDailyRollup'],
    () =>
      prisma.reviewVerdictDailyRollup.groupBy({
        by: ['day'],
        where: {
          bucketVersion: WORKFLOW_RUN_ROLLUP_BUCKET_VERSION,
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

export function requestedAtWhere(
  ranges: readonly Range[]
): { requestedAt: Range } | { OR: { requestedAt: Range }[] } {
  const [only] = ranges;
  return ranges.length === 1 && only
    ? { requestedAt: only }
    : { OR: ranges.map((range) => ({ requestedAt: range })) };
}
