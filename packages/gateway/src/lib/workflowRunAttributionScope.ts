import type { Prisma, PrismaClient } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { type MaybeGate, reachableConnections } from './tenantScope.js';

export interface WorkflowRunAttributionScope {
  authorized: boolean;
  isAdmin: boolean;
  orgIds: string[];
  repoIds: string[];
  repoWorkflowIds: string[];
  teamId?: string;
  teamIds: string[];
  userId: string;
}

export interface RollupAttributionWhere {
  OR?: RollupAttributionWhere[] | undefined;
  orgId?: { in: string[] } | undefined;
  repoId?: { in: string[] } | undefined;
  teamId?: string | { in: string[] } | undefined;
  launchedById?: string | undefined;
}

export async function resolveWorkflowRunAttributionScope(
  prisma: Pick<
    PrismaClient,
    'activeWorkflow' | 'connection' | 'organizationMembership' | 'team' | 'teamMembership'
  >,
  user: { role: string; sub: string },
  repoAccessGate: MaybeGate,
  teamId?: string
): Promise<WorkflowRunAttributionScope> {
  if (user.role === 'ADMIN') {
    return {
      authorized: true,
      isAdmin: true,
      orgIds: [],
      repoIds: [],
      repoWorkflowIds: [],
      teamId,
      teamIds: [],
      userId: user.sub,
    };
  }
  const [teamMemberships, organizationMemberships, connections] = await Promise.all([
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
    runUnscoped(
      'report repository visibility uses the caller memberships and GitHub permission gate',
      ['Connection'],
      () =>
        prisma.connection.findMany({
          select: { id: true },
          where: reachableConnections(user, repoAccessGate),
        })
    ),
  ]);
  const teamIds = teamMemberships.map((membership) => membership.teamId);
  const orgIds = (
    await Promise.all(
      organizationMemberships.map(async ({ orgId }) =>
        (await resolveSetting('analytics.orgWideReports', { orgId })) ? orgId : null
      )
    )
  ).filter((orgId): orgId is string => orgId !== null);
  const repoIds = connections.map((connection) => connection.id);
  const repoWorkflowIds = repoIds.length
    ? await runUnscoped(
        'report repository visibility maps reachable repositories to their active workflows',
        ['ActiveWorkflow'],
        () =>
          prisma.activeWorkflow.findMany({
            select: { temporalWorkflowId: true },
            where: { repoId: { in: repoIds } },
          })
      ).then((workflows) => workflows.map((workflow) => workflow.temporalWorkflowId))
    : [];
  if (!teamId) {
    return {
      authorized: true,
      isAdmin: false,
      orgIds,
      repoIds,
      repoWorkflowIds,
      teamIds,
      userId: user.sub,
    };
  }
  if (teamIds.includes(teamId)) {
    return {
      authorized: true,
      isAdmin: false,
      orgIds,
      repoIds,
      repoWorkflowIds,
      teamId,
      teamIds,
      userId: user.sub,
    };
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
    repoIds,
    repoWorkflowIds,
    teamId,
    teamIds,
    userId: user.sub,
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
  const visibleRuns: Prisma.WorkflowRunWhereInput[] = [
    { attributedTeamId: { in: scope.teamIds } },
    { attributedOrgId: { in: scope.orgIds } },
    {
      OR: [{ connectionId: { in: scope.repoIds } }, { workflowId: { in: scope.repoWorkflowIds } }],
    },
    { launchedById: scope.userId },
  ];
  return {
    OR: visibleRuns,
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
  const visibleRows: RollupAttributionWhere[] = [
    { teamId: { in: scope.teamIds } },
    { orgId: { in: scope.orgIds } },
    { repoId: { in: scope.repoIds } },
    { launchedById: scope.userId },
  ];
  return {
    OR: visibleRows,
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
