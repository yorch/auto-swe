import type { Prisma } from '@auto-swe/shared';
import { type MaybeGate, memberTeams, reachableConnections } from './tenantScope.js';

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
  actor: VisibilityActor,
  gate: MaybeGate
): Prisma.WorkflowRunWhereInput {
  if (actor.role === 'ADMIN') {
    return {};
  }
  return {
    OR: [
      { template: { teamId: null } },
      { template: { team: memberTeams(actor) } },
      {
        workRequest: {
          activeWorkflows: {
            some: {
              repository: reachableConnections(actor, gate),
            },
          },
        },
      },
    ],
  };
}

/** Build the human-step visibility predicate used by `/inbox` and Slack actions. */
export function buildWorkflowHumanStepVisibilityFilter(
  actor: VisibilityActor,
  gate: MaybeGate
): Prisma.WorkflowHumanStepWhereInput {
  if (actor.role === 'ADMIN') {
    return {};
  }
  return { run: buildWorkflowRunVisibilityFilter(actor, gate) };
}
