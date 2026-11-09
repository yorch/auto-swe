import type { Prisma } from '@auto-swe/shared';

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
