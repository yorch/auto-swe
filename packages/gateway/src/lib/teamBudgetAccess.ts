import type { PrismaClient } from '@auto-swe/shared';
import { isOrgAdmin } from './orgAccess.js';

/** What a caller may do with a team's own budget. */
export interface TeamBudgetAccess {
  team: {
    id: string;
    name: string;
    orgId: string;
    monthlyBudgetUsdCents: number | null;
    budgetAlertThresholdPercent: number | null;
  };
  /** Set the cap and read it in dollars: a team ADMIN, an ORG_ADMIN of the team's org, a platform ADMIN. */
  canManage: boolean;
}

/**
 * Who may reach a team's budget, and how far. Null when the team does not exist or the caller has
 * no standing on it, so a route answers both with the same 404 and a probe learns nothing.
 *
 * Standing is: a member of the team, an ORG_ADMIN of its organization, or a platform ADMIN.
 * Managing is narrower — a team ADMIN, an ORG_ADMIN of the organization, a platform ADMIN. A team
 * LEAD, a platform LEAD and a team ENGINEER read the percentage-only status and nothing more.
 */
export async function teamBudgetAccess(
  prisma: PrismaClient,
  user: { role: string; sub: string },
  teamId: string
): Promise<TeamBudgetAccess | null> {
  const team = await prisma.team.findUnique({
    select: {
      budgetAlertThresholdPercent: true,
      id: true,
      memberships: { select: { role: true }, where: { userId: user.sub } },
      monthlyBudgetUsdCents: true,
      name: true,
      orgId: true,
    },
    where: { id: teamId },
  });
  if (!team) {
    return null;
  }
  const { memberships, ...fields } = team;
  const myRole = memberships[0]?.role ?? null;
  const orgAdmin = await isOrgAdmin(prisma, user, team.orgId);
  if (myRole === null && !orgAdmin) {
    return null;
  }
  return { canManage: myRole === 'ADMIN' || orgAdmin, team: fields };
}
