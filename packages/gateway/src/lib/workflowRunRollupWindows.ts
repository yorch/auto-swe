import type { PrismaClient } from '@auto-swe/shared';
import { DAY_MS } from '@auto-swe/shared/lib/agentTraceRollup';
import { builtRollupDays } from '@auto-swe/shared/lib/rollupBuiltDays';
import { resolveScheduledSweeps } from '@auto-swe/shared/lib/systemConfig';
import { WORKFLOW_RUN_ROLLUP_BUCKET_VERSION } from '@auto-swe/shared/workflow';
import type { Range } from './usageWindows.js';

export function workflowRunRollupHorizonMs(nowMs: number): number {
  const recomputeDays = resolveScheduledSweeps().workflowRunRollup.recomputeDays;
  return Math.floor(nowMs / DAY_MS) * DAY_MS - recomputeDays * DAY_MS;
}

/**
 * UTC days inside `[startMs, endMs)` and below the recompute horizon that the rollup sweep has
 * built. One sweep builds the workflow-run, human-step and review-verdict rollups of a day in a
 * single transaction, so one marker covers all three; a day with no runs has no rows and is
 * still covered.
 */
export async function coveredWorkflowRunBuiltDays(
  prisma: Pick<PrismaClient, 'rollupBuiltDay'>,
  startMs: number,
  endMs: number,
  nowMs: number
): Promise<Set<number>> {
  const horizon = workflowRunRollupHorizonMs(nowMs);
  if (startMs >= horizon) {
    return new Set();
  }
  return builtRollupDays(
    prisma,
    { gte: new Date(startMs), lt: new Date(Math.min(endMs, horizon)) },
    WORKFLOW_RUN_ROLLUP_BUCKET_VERSION
  );
}

export const coveredWorkflowRunRollupDays = coveredWorkflowRunBuiltDays;
export const coveredHumanStepRollupDays = coveredWorkflowRunBuiltDays;
export const coveredReviewVerdictRollupDays = coveredWorkflowRunBuiltDays;

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
