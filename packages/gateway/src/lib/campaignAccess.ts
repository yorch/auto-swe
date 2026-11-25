import type { PlatformRole, Prisma, PrismaClient } from '@auto-swe/shared';
import type { AccessActor, AccessLog } from '@auto-swe/shared/lib/accessActor';
import type { RepoAccessGate } from '@auto-swe/shared/lib/repoAccessGate';
import { repoMembersSelect } from '@auto-swe/shared/lib/repoMembership';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { isPlatformAdmin, can as sharedCan, userActor } from '@auto-swe/shared/permissions';
import type { FastifyRequest } from 'fastify';
import { can } from './authz.js';
import { authorizeLaunch, type LaunchRepo } from './launchAuthorization.js';
import { type MaybeGate, memberTeams, reachableConnections } from './tenantScope.js';

/**
 * Who may do what to a campaign, and the launch decision re-run for one person and one repository.
 *
 * Authority comes from the capability catalog (`team.launch.multi-repo` on the owning team, which a
 * platform ADMIN holds everywhere) and from the creator relation, never from comparing a role
 * value (`yarn invariants:check`).
 */

/** The campaign facts the control decision reads. */
export interface ControlledCampaign {
  createdById: string | null;
  ownerTeamId: string;
}

/**
 * Creator, an owning-team LEAD or a platform ADMIN: who may pause, resume, retry, remove a target,
 * add targets and cancel (spec §7).
 */
export async function mayControlCampaign(
  request: FastifyRequest,
  user: { sub: string; role: PlatformRole },
  campaign: ControlledCampaign
): Promise<boolean> {
  if (isPlatformAdmin(user)) {
    return true;
  }
  if (campaign.createdById !== null && campaign.createdById === user.sub) {
    return true;
  }
  return (await can(request, 'team.launch.multi-repo', { teamId: campaign.ownerTeamId })).allowed;
}

/**
 * An owning-team LEAD or a platform ADMIN: who may take a campaign over (spec §7). The creator, as
 * such, may not: handing over a campaign is a decision of the team's authority, not of whoever
 * started it. The caller refuses the current launcher separately.
 */
export async function mayTakeOverCampaign(
  request: FastifyRequest,
  user: { sub: string; role: PlatformRole },
  campaign: { ownerTeamId: string }
): Promise<boolean> {
  if (isPlatformAdmin(user)) {
    return true;
  }
  return (await can(request, 'team.launch.multi-repo', { teamId: campaign.ownerTeamId })).allowed;
}

/** What the launch decision reads of a repository, for one acting user. */
function launchRepoSelect(userId: string) {
  return {
    githubApiUrl: true,
    githubUrl: true,
    id: true,
    installation: { select: { host: true, installationId: true, isActive: true } },
    isActive: true,
    organizationName: true,
    repoName: true,
    scmProvider: true,
    shares: repoMembersSelect({ userId: true }, { userId }).shares,
    team: {
      select: {
        id: true,
        isActive: true,
        memberships: { select: { userId: true }, where: { userId } },
        monthlyBudgetUsdCents: true,
        name: true,
        organization: { select: { id: true, monthlyBudgetUsdCents: true } },
        orgId: true,
      },
    },
    teamId: true,
    type: true,
  } as const;
}

/**
 * The repositories of `ids` as the launch decision reads them for `userId`. Unscoped for the reason
 * the launch routes give: access is decided from the memberships selected here, and filtering by
 * team up front would turn "you cannot reach this" into "no such repository".
 */
export async function loadLaunchRepos(prisma: PrismaClient, userId: string, ids: string[]) {
  if (ids.length === 0) {
    return [];
  }
  return runUnscoped(
    'access is decided from the memberships selected here, not by the where clause',
    ['Connection'],
    () =>
      prisma.connection.findMany({
        select: launchRepoSelect(userId),
        where: { id: { in: ids } },
      })
  );
}

export type LoadedLaunchRepo = Awaited<ReturnType<typeof loadLaunchRepos>>[number];

/** The one reason given for a repository that is missing or that the caller may not lead. */
export const NOT_LED_REASON = 'not found, or you may not start work in it';

export type TargetLaunchDecision = { ok: true } | { ok: false; reason: string };

/**
 * The standard launch decision for ONE repository as `actor`, as a refusal reason rather than an
 * HTTP reply: the repository still exists, is active, is a git repository, is on GitHub, and the
 * actor passes `authorizeLaunch` with the owning-team LEAD requirement (repository access, the
 * organization checks and both budgets). Used for the attempt route, take-over and adding targets.
 */
export async function decideTargetLaunch(
  prisma: PrismaClient,
  actor: AccessActor,
  repo: LoadedLaunchRepo | undefined,
  options: { gate: RepoAccessGate | undefined; log?: AccessLog }
): Promise<TargetLaunchDecision> {
  if (!repo) {
    return { ok: false, reason: NOT_LED_REASON };
  }
  // Authorization first, as the launch route orders it: whether the repository is inactive, on
  // another provider or in another organization is told only to someone who may start work in
  // its team, so a caller cannot probe arbitrary connection ids.
  if (
    !(await sharedCan(prisma, userActor(actor), 'team.launch.multi-repo', { teamId: repo.teamId }))
      .allowed
  ) {
    return { ok: false, reason: NOT_LED_REASON };
  }
  if (!repo.isActive || repo.type !== 'git_repo' || !repo.team.isActive) {
    return { ok: false, reason: 'the repository no longer exists or is inactive' };
  }
  if (repo.scmProvider !== 'github') {
    return { ok: false, reason: 'the repository is not on GitHub' };
  }
  const decision = await authorizeLaunch(prisma, actor, {
    gate: options.gate,
    log: options.log,
    refusalShape: 'single',
    repos: [repo as LaunchRepo],
    requireOwningTeamLead: true,
    runIdentity: 'caller',
  });
  if (decision.ok) {
    return { ok: true };
  }
  const error = decision.refusal.body.error as { code: string; message?: string };
  return { ok: false, reason: error.message ?? error.code };
}

/**
 * The campaigns a non-admin may see: those their team owns, and those with at least one target
 * repository they can reach. The detail and action routes ask the same question by id. The list
 * query spells the same shape out inline so the tenant-guard audit can read its keys.
 */
export function visibleToMember(
  user: { sub: string },
  gate: MaybeGate
): Prisma.CampaignWhereInput['OR'] {
  return [
    { ownerTeam: memberTeams(user) },
    { targets: { some: { connection: reachableConnections(user, gate) } } },
  ];
}
