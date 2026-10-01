import type { Prisma } from '@auto-swe/shared';
import {
  type MaybeGate,
  memberTeams,
  permissionRequirement,
  reachableConnections,
} from './tenantScope.js';

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

/**
 * Runs the actor may CONTROL — cancel, or answer a human step on. Narrower than
 * {@link buildWorkflowRunVisibilityFilter}: a repository shared with the actor's
 * team lets them see the owning team's runs and start their own, not stop or
 * steer the owning team's. So the repository branch is the owning team's
 * members only, plus whoever launched the run, which keeps a shared-team
 * member in control of the runs they started.
 */
export function buildWorkflowRunControlFilter(
  actor: VisibilityActor,
  gate: MaybeGate
): Prisma.WorkflowRunWhereInput {
  if (actor.role === 'ADMIN') {
    return {};
  }
  // No "global template" branch, unlike visibility: every engineering run uses
  // a built-in global template, so that branch would hand control of every
  // run to every signed-in user. Control comes from owning the repository, the
  // team-owned template, or having launched the run.
  return {
    OR: [
      { template: { team: memberTeams(actor) } },
      { launchedById: actor.sub },
      {
        workRequest: {
          activeWorkflows: {
            some: {
              repository: {
                AND: [{ team: memberTeams(actor) }, permissionRequirement(actor, gate)],
              },
            },
          },
        },
      },
    ],
  };
}

/** Human steps the actor may answer — see {@link buildWorkflowRunControlFilter}. */
export function buildWorkflowHumanStepControlFilter(
  actor: VisibilityActor,
  gate: MaybeGate
): Prisma.WorkflowHumanStepWhereInput {
  if (actor.role === 'ADMIN') {
    return {};
  }
  return { run: buildWorkflowRunControlFilter(actor, gate) };
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
