import type { PrismaClient } from '@auto-swe/shared';
import type { RepoAccessGate } from '@auto-swe/shared/lib/repoAccessGate';
import { isRepoMember, repoMembersSelect } from '@auto-swe/shared/lib/repoMembership';
import type { JwtPayload } from '../../plugins/auth.js';
import { permissionRequirement } from '../tenantScope.js';

/**
 * The repository an event-automation route acts on, with whether the caller may read its
 * automations (a member of the owning team or of a team it is shared with, or ADMIN; under an
 * enforcing access gate also holding a current host permission) and manage them (ADMIN, or a
 * LEAD of the OWNING team: an event automation starts runs with the platform credential on the
 * team's repository, so a shared team reads but does not manage). Null when it is not a git
 * repository or the caller may not read it — answered 404 either way.
 */
/**
 * What a launch decision reads of a repository, with one user's memberships: the shape
 * `authorizeLaunch` takes (`LaunchRepo`), plus the type and team id the automation routes use.
 */
function launchRepoSelect(userId: string) {
  return {
    githubApiUrl: true,
    githubUrl: true,
    id: true,
    installation: { select: { host: true, installationId: true, isActive: true } },
    isActive: true,
    organizationName: true,
    repoName: true,
    shares: repoMembersSelect({ userId: true }, { userId }).shares,
    team: {
      select: {
        memberships: { select: { role: true, userId: true }, where: { userId } },
        organization: { select: { monthlyBudgetUsdCents: true } },
        orgId: true,
      },
    },
    teamId: true,
    type: true,
  } as const;
}

/** A git repository as a launch decision reads it, for one user; null when there is none. */
export async function findLaunchRepo(prisma: PrismaClient, connectionId: string, userId: string) {
  const repo = await prisma.connection.findFirst({
    select: launchRepoSelect(userId),
    where: { id: connectionId, isActive: true, type: 'git_repo' },
  });
  return repo;
}

export async function repoAutomationAccess(
  prisma: PrismaClient,
  connectionId: string,
  user: JwtPayload,
  gate: RepoAccessGate | undefined
) {
  const admin = user.role === 'ADMIN';
  const repo = await prisma.connection.findFirst({
    select: launchRepoSelect(user.sub),
    where: { id: connectionId, ...(admin ? {} : permissionRequirement(user, gate)) },
  });
  if (repo?.type !== 'git_repo') {
    return null;
  }
  if (!admin && !isRepoMember(repo, user.sub)) {
    return null;
  }
  const role = repo.team.memberships[0]?.role;
  return { canManage: admin || role === 'LEAD' || role === 'ADMIN', repo };
}

export type RepoAutomationAccess = NonNullable<Awaited<ReturnType<typeof repoAutomationAccess>>>;

/**
 * The team a team automation belongs to, with whether the caller may read its automations (a
 * member of the team, or ADMIN) and manage them (ADMIN, or a LEAD of the team). Null when there
 * is no such team or the caller is not a member — answered 404 either way.
 */
export async function teamAutomationAccess(prisma: PrismaClient, teamId: string, user: JwtPayload) {
  const admin = user.role === 'ADMIN';
  // One team by id, then the membership check below: the fetch-then-check shape.
  const team = await prisma.team.findUnique({
    select: {
      id: true,
      isActive: true,
      memberships: { select: { role: true }, where: { userId: user.sub } },
      name: true,
      organization: { select: { id: true, monthlyBudgetUsdCents: true } },
      orgId: true,
    },
    where: { id: teamId },
  });
  if (!team) {
    return null;
  }
  const role = team.memberships[0]?.role;
  if (!admin && !role) {
    return null;
  }
  return { canManage: admin || role === 'LEAD' || role === 'ADMIN', team };
}

export type TeamAutomationAccess = NonNullable<Awaited<ReturnType<typeof teamAutomationAccess>>>;

/** What an automation belongs to, as its routes act on it. */
export type AutomationOwnerAccess =
  | ({ kind: 'repository' } & RepoAutomationAccess)
  | ({ kind: 'team' } & TeamAutomationAccess);

/**
 * The caller's access to what an automation belongs to: its repository when it has one (a row
 * with a repository is a repository automation whatever else it names), else its team. Null
 * when the caller may not read it.
 */
export async function automationOwnerAccess(
  prisma: PrismaClient,
  owner: { connectionId: string | null; teamId: string | null },
  user: JwtPayload,
  gate: RepoAccessGate | undefined
): Promise<AutomationOwnerAccess | null> {
  if (owner.connectionId !== null) {
    const access = await repoAutomationAccess(prisma, owner.connectionId, user, gate);
    return access ? { kind: 'repository', ...access } : null;
  }
  if (owner.teamId !== null) {
    const access = await teamAutomationAccess(prisma, owner.teamId, user);
    return access ? { kind: 'team', ...access } : null;
  }
  return null;
}

/** The team an owner's decisions are made for: the repository's owning team, or the team. */
export function ownerTeam(access: AutomationOwnerAccess): { id: string; orgId: string } {
  return access.kind === 'repository'
    ? { id: access.repo.teamId, orgId: access.repo.team.orgId }
    : { id: access.team.id, orgId: access.team.orgId };
}

export const MANAGE_FORBIDDEN =
  'Requires ADMIN role, or LEAD membership on the repository owning team';

export const TEAM_MANAGE_FORBIDDEN = 'Requires ADMIN role, or LEAD membership on the team';

/** The refusal for a caller who may read an owner's automations but not manage them. */
export function manageForbidden(access: AutomationOwnerAccess): string {
  return access.kind === 'repository' ? MANAGE_FORBIDDEN : TEAM_MANAGE_FORBIDDEN;
}
