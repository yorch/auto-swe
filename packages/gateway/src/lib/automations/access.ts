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

export const MANAGE_FORBIDDEN =
  'Requires ADMIN role, or LEAD membership on the repository owning team';
