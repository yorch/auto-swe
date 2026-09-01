import type { Prisma } from '@auto-swe/shared';

/** A caller that needs a run- or step-level visibility predicate. */
export interface VisibilityActor {
  sub: string;
  role: string;
}

/**
 * Build the run-level visibility predicate used by `/runs` and `/templates`.
 * ADMINs see all runs; everyone else sees global templates, templates owned by
 * one of their teams, or runs whose work request touches a repo on one of their
 * teams.
 */
export function buildWorkflowRunVisibilityFilter(
  actor: VisibilityActor
): Prisma.WorkflowRunWhereInput {
  if (actor.role === 'ADMIN') {
    return {};
  }
  return {
    OR: [
      { template: { teamId: null } },
      { template: { team: { memberships: { some: { userId: actor.sub } } } } },
      {
        workRequest: {
          activeWorkflows: {
            some: {
              repository: { team: { memberships: { some: { userId: actor.sub } } } },
            },
          },
        },
      },
    ],
  };
}

/** Build the human-step visibility predicate used by `/inbox` and Slack actions. */
export function buildWorkflowHumanStepVisibilityFilter(
  actor: VisibilityActor
): Prisma.WorkflowHumanStepWhereInput {
  if (actor.role === 'ADMIN') {
    return {};
  }
  return { run: buildWorkflowRunVisibilityFilter(actor) };
}
