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
 * Build the run-level visibility predicate used by `/runs`, `/templates`, HITL
 * resolution and the Slack run buttons — for most of those it is the only
 * authorization check, so it decides who may cancel a run or resolve its gates,
 * not just who may read it.
 *
 * ADMINs see all runs. Everyone else sees a run only through the run itself:
 *
 * - they requested it;
 * - its work request targets a repository they can reach (per repo in
 *   `activeWorkflows`, or the generic `connection`) — single-repository work
 *   requests only, see below;
 * - it records its own repository (`WorkflowRun.connection`, an epic child)
 *   and they can reach that one;
 * - it runs a template owned by one of their teams;
 * - it is a channel-assistant run in a Slack channel owned by one of their
 *   teams — the same audience `assertChannelAccess` admits to the channel's
 *   config and its audit feed, which links to these runs.
 *
 * What a run's *template* is shared with is deliberately not a term. GLOBAL
 * templates — every built-in, and the default any team falls back to — are
 * readable by everyone, so "the template is global" would make every run of the
 * default engineering workflow visible, cancellable and approvable by every
 * user on the platform.
 *
 * Multi-repository runs are decided per run, never through the shared work
 * request. Every child of an epic links the epic's work request, and the
 * epic's children each put their repository on a ledger row under it — so
 * "some ledger row of the work request is reachable" would hand a member of
 * any one of the epic's teams every child, to view, cancel and approve. The
 * `activeWorkflows` term is therefore limited to work requests that are not
 * cross-repo, and an epic child is reached through its own `connection`. A PRD
 * run records its primary repository as its work request's `connection`, so it
 * is visible to that repository's team; the teams of its other repositories
 * see the per-repo work requests it submits. Every term is an exact relational
 * match — none substring-matches a payload.
 *
 * What stays ADMIN-and-requester only, by design:
 *
 * - a run with no work request, no channel and no team-owned template;
 * - a template run launched with no connection on a GLOBAL template;
 * - an epic child from before its run recorded a repository, when the
 *   migration's backfill could not recover one.
 *
 * The requester term is not re-checked against current membership: someone
 * who launched a run keeps seeing it after leaving the team.
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
      { workRequest: { requestedById: actor.sub } },
      {
        workRequest: {
          activeWorkflows: {
            some: {
              repository: reachableConnections(actor, gate),
            },
          },
          isCrossRepo: false,
        },
      },
      { workRequest: { connection: reachableConnections(actor, gate) } },
      { connection: reachableConnections(actor, gate) },
      { template: { team: memberTeams(actor) } },
      { channel: { team: memberTeams(actor) } },
    ],
  };
}

/**
 * Runs the actor may CONTROL — cancel, or answer a human step on. Narrower than
 * {@link buildWorkflowRunVisibilityFilter}: a repository shared with the actor's
 * team lets them see the owning team's runs and start their own, not stop or
 * steer the owning team's. So the repository branches are the owning team's
 * members only, plus whoever launched the run, which keeps a shared-team
 * member in control of the runs they started.
 *
 * Repository ownership is matched per run, exactly as visibility does, and for
 * the same reason: every child of an epic links the epic's work request, and
 * each child puts its own repository on a ledger row under it. "Some ledger row
 * of the work request is in my team's repository" would hand a member of any one
 * of the epic's teams control of every child. So the work-request ledger term is
 * limited to single-repository requests, and an epic child — or a PRD run, whose
 * primary repository is its work request's `connection` — is reached through the
 * repository the run itself records.
 */
export function buildWorkflowRunControlFilter(
  actor: VisibilityActor,
  gate: MaybeGate
): Prisma.WorkflowRunWhereInput {
  if (actor.role === 'ADMIN') {
    return {};
  }
  const ownedRepository = {
    AND: [{ team: memberTeams(actor) }, permissionRequirement(actor, gate)],
  };
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
          activeWorkflows: { some: { repository: ownedRepository } },
          isCrossRepo: false,
        },
      },
      { workRequest: { connection: ownedRepository } },
      { connection: ownedRepository },
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
