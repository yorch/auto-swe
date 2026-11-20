import type { PrismaClient } from '@auto-swe/shared';
import type { Authority } from '@auto-swe/shared/permissions';
import type { FastifyRequest } from 'fastify';
import { can } from './authz.js';

/** What a caller may do with a team's own budget. */
export interface TeamBudgetAccess {
  team: {
    id: string;
    name: string;
    orgId: string;
    monthlyBudgetUsdCents: number | null;
    budgetAlertThresholdPercent: number | null;
  };
  /** Set the cap and read it in dollars (`team.budget.manage`). */
  canManage: boolean;
  /** The ground the caller's standing on the team rests on, for the audit record of a change. */
  authority: Authority;
}

/**
 * Who may reach a team's budget, and how far. Null when the team does not exist or the caller has
 * no standing on it, so a route answers both with the same 404 and a probe learns nothing.
 *
 * Standing is `team.budget.read`; managing is `team.budget.manage`, which is narrower. A route
 * that calls this declares both capabilities in `requireAuth({ handlerChecked })`.
 */
export async function teamBudgetAccess(
  request: FastifyRequest,
  prisma: PrismaClient,
  teamId: string
): Promise<TeamBudgetAccess | null> {
  const team = await prisma.team.findUnique({
    select: {
      budgetAlertThresholdPercent: true,
      id: true,
      monthlyBudgetUsdCents: true,
      name: true,
      orgId: true,
    },
    where: { id: teamId },
  });
  if (!team) {
    return null;
  }
  const read = await can(request, 'team.budget.read', { teamId });
  if (!read.allowed) {
    return null;
  }
  const manage = await can(request, 'team.budget.manage', { teamId });
  return {
    authority: manage.allowed ? manage.authority : read.authority,
    canManage: manage.allowed,
    team,
  };
}
