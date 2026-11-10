import type { Prisma, PrismaClient } from '@auto-swe/shared';
import { memberRunScope, runListTeamScope } from './runTeamScope.js';
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
 * The steps `actionable` selects: pending, not expired, not already answered by the caller, and on
 * a RUNNING run the caller CONTROLS (answering a step of a finished run is refused). The run-status
 * term is its own `AND` element, beside the control filter's `run` key. One definition, read by {@link humanStepListWhere} and by
 * {@link answerableStepIds}, so the list filter and a step's `canAnswer` cannot disagree.
 */
export function humanStepActionableWhere(
  user: VisibilityActor,
  gate: MaybeGate
): Prisma.WorkflowHumanStepWhereInput {
  return {
    humanApprovals: { none: { resolvedBy: user.sub } },
    OR: [{ timeoutAt: null }, { timeoutAt: { gt: new Date() } }],
    status: 'PENDING' as const,
    ...buildWorkflowHumanStepControlFilter(user, gate),
    AND: [{ run: { status: 'RUNNING' as const } }],
  };
}

/**
 * Which of the named steps the caller may answer right now: one query for all of them. Nested under
 * `AND` with the id term, since the actionable predicate owns the `OR` key.
 */
export async function answerableStepIds(
  prisma: PrismaClient,
  user: VisibilityActor,
  gate: MaybeGate,
  stepIds: readonly string[]
): Promise<Set<string>> {
  if (stepIds.length === 0) {
    return new Set();
  }
  const rows = await prisma.workflowHumanStep.findMany({
    select: { id: true },
    where: { AND: [{ id: { in: [...stepIds] } }, humanStepActionableWhere(user, gate)] },
  });
  return new Set(rows.map((r) => r.id));
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
  const actionableWhere = actionable ? humanStepActionableWhere(user, gate) : null;
  return {
    ...(status === 'ALL' ? {} : { status: 'PENDING' as const }),
    ...(runId ? { runId } : {}),
    ...(overdue ? { timeoutAt: { lt: new Date() } } : {}),
    // "Actionable" is control, not visibility: a step on a run the caller can
    // see but not answer is not waiting on them. A step they already approved
    // is waiting on someone else, and an expired one cannot be answered.
    ...(actionableWhere ?? buildWorkflowHumanStepVisibilityFilter(user, gate)),
    // Under AND so it can only narrow, whatever the filters above spread. A timeout or
    // someone else's answer leaves neither `resolvedBy` nor an approval row for the caller.
    // The actionable predicate's own AND elements (the run-status term) are kept beside it.
    ...(answeredByMe
      ? {
          AND: [
            ...((actionableWhere?.AND as Prisma.WorkflowHumanStepWhereInput[] | undefined) ?? []),
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

/**
 * The member-scope term of a personal desk: steps on runs of the caller's own teams' work. The
 * visibility and control filters are `{}` for a platform ADMIN, so `mine=true` and the desk
 * summary AND this beside {@link humanStepListWhere}; the list and the summary then count the
 * same steps.
 */
export function humanStepMineScope(user: VisibilityActor): Prisma.WorkflowHumanStepWhereInput {
  return { run: memberRunScope(user) };
}

/**
 * The team term of `GET /human-steps?teamId=`: steps on runs of one team's work, owned or shared.
 * AND it beside {@link humanStepListWhere}; it narrows only.
 */
export function humanStepTeamScope(teamId: string): Prisma.WorkflowHumanStepWhereInput {
  return { run: runListTeamScope(teamId) };
}
