import type { PrismaClient } from '@auto-swe/shared';

/** What {@link ownerTeamIdsOfStepRun} reads, as a `select` on a `WorkflowRun`. */
export const STEP_RUN_OWNER_SELECT = {
  connection: { select: { team: { select: { id: true } } } },
  template: { select: { teamId: true } },
  workRequest: { select: { connection: { select: { team: { select: { id: true } } } } } },
} as const;

interface StepRunOwners {
  connection?: { team: { id: string } } | null;
  template?: { teamId: string | null } | null;
  workRequest?: { connection?: { team: { id: string } } | null } | null;
}

/** The teams that own a step's run: its repository's, its request's repository's and its template's. */
export function ownerTeamIdsOfStepRun(run: StepRunOwners | null): string[] {
  if (!run) {
    return [];
  }
  return [
    ...new Set(
      [run.connection?.team.id, run.workRequest?.connection?.team.id, run.template?.teamId].filter(
        (id): id is string => typeof id === 'string'
      )
    ),
  ];
}

/**
 * Which of `teamIds` the user is a LEAD or ADMIN of while the team is active: one query for any
 * number of steps. A platform ADMIN may nudge any step; anyone else needs one of its owner teams here.
 */
export async function leadTeamIdsAmong(
  prisma: PrismaClient,
  userId: string,
  teamIds: string[]
): Promise<Set<string>> {
  if (teamIds.length === 0) {
    return new Set();
  }
  const rows = await prisma.teamMembership.findMany({
    select: { teamId: true },
    where: {
      role: { in: ['LEAD', 'ADMIN'] },
      team: { isActive: true },
      teamId: { in: teamIds },
      userId,
    },
  });
  return new Set(rows.map((row) => row.teamId));
}
