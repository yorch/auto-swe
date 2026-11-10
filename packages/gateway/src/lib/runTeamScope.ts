import type { Prisma } from '@auto-swe/shared';
import type { ScopeActor } from './tenantScope.js';

/**
 * Repositories a team owns or that are shared to it. Nest under a `repository` / `connection`
 * relation key, never spread.
 */
export function repositoryTeamScope(teamId: string): Prisma.ConnectionWhereInput {
  return { OR: [{ teamId }, { shares: { some: { teamId } } }] };
}

/**
 * Runs a team SEES in a list: runs on a repository the team owns OR that is shared to it, the
 * request's repository for requests that name one, a single-repository request's ledger rows, and
 * runs of a template the team owns.
 *
 * Use it wherever the answer to "what is on the team's board?" is a list of work to open: the
 * request workspace, run lists, pull-request lists. A member of a sharee team is meant to see the
 * owning team's work on a shared repository, so this scope includes it.
 *
 * Do NOT use it for counts, rates or spend that are reported per team: a shared repository would
 * be counted by both teams. Use {@link runMetricsTeamScope}.
 *
 * It narrows only. Place it in its own `AND` term next to the visibility filter; it grants no access.
 */
export function runListTeamScope(teamId: string): Prisma.WorkflowRunWhereInput {
  return {
    OR: [
      { connection: repositoryTeamScope(teamId) },
      { workRequest: { connection: repositoryTeamScope(teamId) } },
      {
        workRequest: {
          activeWorkflows: { some: { repository: repositoryTeamScope(teamId) } },
          isCrossRepo: false,
        },
      },
      { template: { teamId } },
    ],
  };
}

/**
 * Runs attributed to a team for REPORTING: owner-only. A run is attributed to exactly one team, so
 * a total summed across teams never counts the same run twice, and a repository shared to another
 * team does not add to that team's numbers.
 *
 * Use it for outcomes, exports, cost and any other metric. A run without an attribution matches no
 * team. For a pull-request metric, nest it under the `run` relation.
 *
 * It narrows only. Place it in its own `AND` term next to the visibility filter.
 */
export function runMetricsTeamScope(teamId: string): Prisma.WorkflowRunWhereInput {
  return { attributedTeamId: teamId };
}

/** The actor's teams that are still active: a deactivated team has no card on the desk. */
function activeMemberTeams(actor: ScopeActor): Prisma.TeamWhereInput {
  return { isActive: true, memberships: { some: { userId: actor.sub } } };
}

/**
 * Runs on the work of the actor's OWN teams: a repository one of their teams owns or that is
 * shared to one of them, the request's repository, a single-repository request's ledger rows, and
 * a template one of their teams owns, counting only teams that are active. The same four terms as {@link runListTeamScope}, over every
 * team the actor is a member of instead of one named team.
 *
 * Visibility and control filters are `{}` for a platform ADMIN, so a query bounded only by them
 * lists the whole platform. A personal desk is the caller's teams' work even for an ADMIN: AND
 * this next to the visibility or control filter. It narrows only; it grants no access.
 */
export function memberRunScope(actor: ScopeActor): Prisma.WorkflowRunWhereInput {
  const teams = activeMemberTeams(actor);
  const repositories: Prisma.ConnectionWhereInput = {
    OR: [{ team: teams }, { shares: { some: { team: teams } } }],
  };
  return {
    OR: [
      { connection: repositories },
      { workRequest: { connection: repositories } },
      {
        workRequest: {
          activeWorkflows: { some: { repository: repositories } },
          isCrossRepo: false,
        },
      },
      { template: { team: teams } },
    ],
  };
}

const teamRef = { select: { id: true, name: true, slug: true } } as const;
const repositoryRef = {
  select: {
    name: true,
    organizationName: true,
    repoName: true,
    shares: { select: { teamId: true } },
    team: teamRef,
  },
} as const;

/**
 * What {@link teamsOfRun} reads, as a `select` on a `WorkflowRun`: the same relations
 * {@link runListTeamScope} filters through, so a run is attributed to the teams a list scoped to
 * that team would show it under.
 */
export const RUN_TEAM_SELECT = {
  connection: repositoryRef,
  template: { select: { team: teamRef } },
  workflowId: true,
  workRequest: {
    select: {
      activeWorkflows: {
        select: { currentStatus: true, repository: repositoryRef, temporalWorkflowId: true },
      },
      connection: repositoryRef,
      isCrossRepo: true,
    },
  },
} as const satisfies Prisma.WorkflowRunSelect;

export type RunTeamRow = Prisma.WorkflowRunGetPayload<{ select: typeof RUN_TEAM_SELECT }>;

type Repository = NonNullable<RunTeamRow['connection']>;

/** A repository's name as a list shows it: `owner/name`, else its display name. */
export function repositoryLabel(repo: Repository | null | undefined): string | null {
  if (!repo) {
    return null;
  }
  return repo.repoName
    ? [repo.organizationName, repo.repoName].filter(Boolean).join('/')
    : (repo.name ?? null);
}

/**
 * The repository a run acts on, by the order a request list names it: the run's own, the
 * request's, then a ledger row's.
 */
export function repositoryOfRun(run: RunTeamRow): Repository | null {
  return (
    run.connection ??
    run.workRequest?.connection ??
    run.workRequest?.activeWorkflows.find((ledger) => ledger.temporalWorkflowId === run.workflowId)
      ?.repository ??
    // A multi-repository request's first ledger row is some other run's repository, which the
    // caller may not be able to see: name it only when it is this run's own.
    (run.workRequest?.isCrossRepo ? null : run.workRequest?.activeWorkflows[0]?.repository) ??
    null
  );
}

/**
 * The teams a run sits under, in memory: the owner, and every team id that owns or is shared the
 * run's repository, or owns its template. The in-memory twin of {@link runListTeamScope}, used
 * where one query must be bucketed by team instead of run once per team. The two read the same
 * relations, and `meSummary.pg.test.ts` holds them to the same answer.
 */
export function teamsOfRun(run: RunTeamRow): {
  owner: { id: string; name: string; slug: string } | null;
  teamIds: Set<string>;
} {
  const repositories: Repository[] = [];
  if (run.connection) {
    repositories.push(run.connection);
  }
  if (run.workRequest?.connection) {
    repositories.push(run.workRequest.connection);
  }
  if (run.workRequest && !run.workRequest.isCrossRepo) {
    for (const ledger of run.workRequest.activeWorkflows) {
      if (ledger.repository) {
        repositories.push(ledger.repository);
      }
    }
  }
  const teamIds = new Set<string>();
  for (const repo of repositories) {
    if (repo.team) {
      teamIds.add(repo.team.id);
    }
    for (const share of repo.shares) {
      teamIds.add(share.teamId);
    }
  }
  if (run.template?.team) {
    teamIds.add(run.template.team.id);
  }
  const owner = repositories.find((repo) => repo.team)?.team ?? run.template?.team ?? null;
  return { owner, teamIds };
}

/**
 * What {@link ownerTeamOfRun} reads, as a `select` on a `WorkflowRun`: the owning team of the run's
 * repository, and of its request's repository for a run that records none itself.
 */
export const RUN_OWNER_TEAM_SELECT = {
  connection: { select: { team: teamRef } },
  workRequest: { select: { connection: { select: { team: teamRef } } } },
} as const;

/**
 * The team that owns the run's repository, or null when it has none. Only the repository's owner
 * is named, which anyone who sees the repository already sees in the repository listing; a team
 * attributed only through a template or channel is not.
 */
export function ownerTeamOfRun(run: {
  connection?: { team: { id: string; name: string; slug: string } } | null;
  workRequest?: { connection?: { team: { id: string; name: string; slug: string } } | null } | null;
}): { id: string; name: string; slug: string } | null {
  return run.connection?.team ?? run.workRequest?.connection?.team ?? null;
}
