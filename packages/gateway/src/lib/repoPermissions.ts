import { Role } from '@auto-swe/shared';
import type { FastifyInstance } from 'fastify';
import { hasRole } from '../plugins/auth.js';

/**
 * Whether a user may manage repositories owned by `teamId`. Platform ADMINs can
 * manage any team's repos; everyone else must lead that active team or
 * administer its owning organization.
 */
export async function canManageTeamRepos(
  prisma: FastifyInstance['prisma'],
  user: { sub: string; role: string },
  teamId: string
): Promise<boolean> {
  if (user.role === Role.ADMIN) {
    return true;
  }
  const membership = await prisma.teamMembership.findUnique({
    include: { team: { select: { isActive: true } } },
    where: { userId_teamId: { teamId, userId: user.sub } },
  });
  if (membership?.team.isActive && hasRole(membership.role, Role.LEAD)) {
    return true;
  }
  const team = await prisma.team.findUnique({
    select: { isActive: true, orgId: true },
    where: { id: teamId },
  });
  if (!team?.isActive || !team.orgId) {
    return false;
  }
  const orgMembership = await prisma.organizationMembership.findUnique({
    where: { userId_orgId: { orgId: team.orgId, userId: user.sub } },
  });
  return orgMembership?.role === 'ORG_ADMIN';
}
