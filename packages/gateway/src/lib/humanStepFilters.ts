import type { Prisma } from '@auto-swe/shared';
import {
  buildWorkflowHumanStepControlFilter,
  buildWorkflowHumanStepVisibilityFilter,
  type VisibilityActor,
} from './runVisibility.js';
import type { MaybeGate } from './tenantScope.js';

/** The query fields that decide which human steps a list covers. */
export interface HumanStepListQuery {
  actionable: boolean;
  answeredByMe: boolean;
  overdue: boolean;
  runId?: string | undefined;
  status: 'PENDING' | 'ALL';
}

/**
 * The `where` of the human-step list, and of every count that must agree with it (the sidebar
 * badge reads the list's `meta.total`). One definition, so a count can never include a step the
 * list would not show.
 *
 * `actionable` is control, not visibility: a step on a run the caller can see but not answer is
 * not waiting on them. A step they already approved is waiting on someone else, and an expired
 * one cannot be answered. Without it the list is bounded by visibility.
 */
export function humanStepListWhere(
  user: VisibilityActor,
  gate: MaybeGate,
  query: HumanStepListQuery
): Prisma.WorkflowHumanStepWhereInput {
  const { actionable, answeredByMe, overdue, runId, status } = query;
  return {
    ...(status === 'ALL' ? {} : { status: 'PENDING' as const }),
    ...(runId ? { runId } : {}),
    ...(overdue ? { timeoutAt: { lt: new Date() } } : {}),
    // "Actionable" is control, not visibility: a step on a run the caller can
    // see but not answer is not waiting on them. A step they already approved
    // is waiting on someone else, and an expired one cannot be answered.
    ...(actionable
      ? {
          humanApprovals: { none: { resolvedBy: user.sub } },
          OR: [{ timeoutAt: null }, { timeoutAt: { gt: new Date() } }],
          status: 'PENDING' as const,
          ...buildWorkflowHumanStepControlFilter(user, gate),
        }
      : buildWorkflowHumanStepVisibilityFilter(user, gate)),
    // Under AND so it can only narrow, whatever the filters above spread. A timeout or
    // someone else's answer leaves neither `resolvedBy` nor an approval row for the caller.
    ...(answeredByMe
      ? {
          AND: [
            {
              OR: [
                { resolvedBy: user.sub },
                { humanApprovals: { some: { resolvedBy: user.sub } } },
              ],
            },
          ],
        }
      : {}),
  };
}
