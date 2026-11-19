import { can, userActor } from '@auto-swe/shared/permissions';
import type { FastifyInstance } from 'fastify';

/**
 * Whether a user may manage repositories owned by `teamId`: `team.repos.manage` on that team.
 *
 * Kept for the routes of other domains that still ask it with a Prisma client instead of a
 * request. A route that has the request asks `can(request, 'team.repos.manage', { teamId })`
 * from `lib/authz.ts` directly.
 */
export async function canManageTeamRepos(
  prisma: FastifyInstance['prisma'],
  user: { sub: string; role: string },
  teamId: string
): Promise<boolean> {
  const decision = await can(prisma, userActor(user), 'team.repos.manage', { teamId });
  return decision.allowed;
}
