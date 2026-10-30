import type { Prisma, PrismaClient } from '@auto-swe/shared';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';

export interface WorkflowRunAttributionScope {
  authorized: boolean;
  isAdmin: boolean;
  orgIds: string[];
  teamId?: string;
  teamIds: string[];
}

export interface RollupAttributionWhere {
  orgId?: { in: string[] } | undefined;
  teamId?: string | { in: string[] } | undefined;
  OR?: RollupAttributionWhere[] | undefined;
}

export async function resolveWorkflowRunAttributionScope(
  prisma: Pick<PrismaClient, 'organizationMembership' | 'team' | 'teamMembership'>,
  user: { role: string; sub: string },
  teamId?: string
): Promise<WorkflowRunAttributionScope> {
  if (user.role === 'ADMIN') {
    return { authorized: true, isAdmin: true, orgIds: [], teamId, teamIds: [] };
  }
  const [teamMemberships, organizationMemberships] = await Promise.all([
    runUnscoped(
      'report visibility is derived from the caller’s own team memberships',
      ['TeamMembership'],
      () =>
        prisma.teamMembership.findMany({
          select: { teamId: true },
          where: { userId: user.sub },
        })
    ),
    runUnscoped(
      'report visibility is derived from the caller’s own organization memberships',
      ['OrganizationMembership'],
      () =>
        prisma.organizationMembership.findMany({
          select: { orgId: true },
          where: { role: 'ORG_ADMIN', userId: user.sub },
        })
    ),
  ]);
  const teamIds = teamMemberships.map((membership) => membership.teamId);
  const orgIds = organizationMemberships.map((membership) => membership.orgId);
  if (!teamId) {
    return { authorized: true, isAdmin: false, orgIds, teamIds };
  }
  if (teamIds.includes(teamId)) {
    return { authorized: true, isAdmin: false, orgIds, teamId, teamIds };
  }
  const team = await runUnscoped(
    'team organization is read only to authorize the requested report filter',
    ['Team'],
    () => prisma.team.findUnique({ select: { orgId: true }, where: { id: teamId } })
  );
  return {
    authorized: !!team?.orgId && orgIds.includes(team.orgId),
    isAdmin: false,
    orgIds,
    teamId,
    teamIds,
  };
}

export function workflowRunAttributionWhere(
  scope: WorkflowRunAttributionScope
): Prisma.WorkflowRunWhereInput {
  if (scope.teamId) {
    return { attributedTeamId: scope.teamId };
  }
  if (scope.isAdmin) {
    return {};
  }
  return {
    OR: [{ attributedTeamId: { in: scope.teamIds } }, { attributedOrgId: { in: scope.orgIds } }],
  };
}

export function workflowRunRollupAttributionWhere(
  scope: WorkflowRunAttributionScope
): RollupAttributionWhere {
  if (scope.teamId) {
    return { teamId: scope.teamId };
  }
  if (scope.isAdmin) {
    return {};
  }
  return {
    OR: [{ teamId: { in: scope.teamIds } }, { orgId: { in: scope.orgIds } }],
  };
}

export function workflowRunWithLegacyVisibility(
  user: { role: string; sub: string },
  legacyVisibility: Prisma.WorkflowRunWhereInput,
  teamId?: string
): Prisma.WorkflowRunWhereInput {
  return {
    AND: [
      user.role === 'ADMIN' ? {} : legacyVisibility,
      ...(teamId ? [{ attributedTeamId: teamId }] : []),
    ],
  };
}
