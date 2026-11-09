import type { Prisma } from '@auto-swe/shared';
import { memberTeams, type ScopeActor } from './tenantScope.js';

/** The slice of the Prisma client the check reads; keeps the helper testable without a database. */
interface TeamReader {
  team: {
    findFirst(args: {
      select: { id: true };
      where: Prisma.TeamWhereInput;
    }): Promise<{ id: string } | null>;
  };
}

/** A `teamId` filter naming a team the caller does not belong to. Answers 404 through the error handler. */
export class TeamNotFoundError extends Error {
  readonly code = 'TEAM_NOT_FOUND';
  readonly statusCode = 404;
  constructor() {
    super('Team not found');
  }
}

/**
 * Refuse a `teamId` query parameter that names a team the caller is not a member of.
 *
 * The parameter only ever narrows a list the caller's visibility already bounds, so it cannot
 * widen access. Without this check, though, the same request would answer "empty" for a team
 * the caller cannot see and for a team they can — which confirms the id exists and lets a
 * caller probe other teams' shared repositories. A non-member gets 404, whether or not the
 * team exists. A platform ADMIN passes.
 */
export async function assertTeamParam(
  prisma: TeamReader,
  user: ScopeActor & { role: string },
  teamId: string
): Promise<void> {
  if (user.role === 'ADMIN') {
    return;
  }
  const team = await prisma.team.findFirst({
    select: { id: true },
    where: { AND: [{ id: teamId }, memberTeams(user)] },
  });
  if (!team) {
    throw new TeamNotFoundError();
  }
}
