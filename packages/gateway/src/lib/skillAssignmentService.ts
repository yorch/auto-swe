import type { PrismaClient } from '@auto-swe/shared';

/**
 * Team-scoped access check, shared by the Agent-library routes and the
 * team-scoped skills-library read. (The per-role skill/tool assignment service
 * was retired in P1.5 — those concerns now live on the first-class Agent
 * entity via `agentLibraryService.ts`.)
 */

export type TeamAccessResult = { ok: true } | { message: string; ok: false };

/// Platform ADMINs always pass; otherwise the user must be a member of the
/// team, and (for writes) hold the team ADMIN role.
export async function checkTeamAccess(
  prisma: PrismaClient,
  user: { role: string; sub: string },
  teamId: string,
  opts: { requireTeamAdmin?: boolean } = {}
): Promise<TeamAccessResult> {
  if (user.role === 'ADMIN') {
    return { ok: true };
  }
  const membership = await prisma.teamMembership.findUnique({
    where: { userId_teamId: { teamId, userId: user.sub } },
  });
  if (!membership) {
    return { message: 'Team membership required', ok: false };
  }
  if (opts.requireTeamAdmin && membership.role !== 'ADMIN') {
    return { message: 'Team admin role required', ok: false };
  }
  return { ok: true };
}
