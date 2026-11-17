import type { PrismaClient } from '@auto-swe/shared';
import type { AccessLog } from '@auto-swe/shared/lib/accessActor';
import { permissionMeets } from '@auto-swe/shared/lib/githubPermission';
import type { RepoAccessGate } from '@auto-swe/shared/lib/repoAccessGate';
import {
  lookupPermissionViaUserCredential,
  lookupRepoPermission,
  type PermissionRepo,
  verifiedGithubLoginFor,
} from '@auto-swe/shared/lib/repoPermission';
import type { FastifyReply } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';
import { sendError } from './httpErrors.js';
import { authorizeLaunch } from './launchAuthorization.js';

/**
 * Authority checks specific to orchestrations: the repo-less launch decision (a member of the
 * named team, the organization's and the team's caps) and the writer child's GitHub push
 * permission.
 */

export interface AuthorizedTeam {
  orgId: string;
  teamId: string;
}

/**
 * The launch decision for a run that names a team rather than a repository: the launcher belongs
 * to the (active) team and its organization, and neither the organization's nor the team's monthly
 * cap is spent. Platform ADMINs bypass membership, not the caps. A team the launcher is not in
 * answers exactly as one that does not exist. Sends the refusal and returns null on failure.
 */
export async function authorizeTeamLaunch(
  prisma: PrismaClient,
  reply: FastifyReply,
  input: {
    gate: RepoAccessGate | undefined;
    log?: AccessLog;
    teamId: string;
    user: JwtPayload;
  }
): Promise<AuthorizedTeam | null> {
  const { user } = input;
  const team = await prisma.team.findFirst({
    select: {
      id: true,
      isActive: true,
      memberships: { select: { userId: true }, where: { userId: user.sub } },
      monthlyBudgetUsdCents: true,
      name: true,
      organization: { select: { id: true, isActive: true, monthlyBudgetUsdCents: true } },
      orgId: true,
    },
    where: { id: input.teamId },
  });
  const member = team ? team.memberships.length > 0 || user.role === 'ADMIN' : false;
  if (!team?.isActive || !team.organization.isActive || !member) {
    sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found');
    return null;
  }
  const decision = await authorizeLaunch(prisma, user, {
    gate: input.gate,
    log: input.log,
    orgs: [{ id: team.orgId, monthlyBudgetUsdCents: team.organization.monthlyBudgetUsdCents }],
    repos: [],
    teams: [
      {
        id: team.id,
        isMember: team.memberships.length > 0,
        monthlyBudgetUsdCents: team.monthlyBudgetUsdCents,
        name: team.name,
      },
    ],
  });
  if (!decision.ok) {
    reply.status(decision.refusal.status).send(decision.refusal.body);
    return null;
  }
  return { orgId: team.orgId, teamId: team.id };
}

export type PushPermission = { ok: true } | { ok: false; reason: string };

/**
 * Whether `userId` holds GitHub write (push) permission on `repo`, asked live. Fails closed: no
 * GitHub identity, an unanswered lookup and a host the platform cannot ask about all refuse.
 * Unlike the access gate this does not depend on the gate's mode and has no ADMIN bypass: the
 * writer pushes a branch as that person's identity.
 */
export async function checkPushPermission(
  prisma: PrismaClient,
  userId: string,
  repo: PermissionRepo & { id: string }
): Promise<PushPermission> {
  try {
    const viaCredential = await lookupPermissionViaUserCredential(prisma, repo, userId);
    const lookup =
      viaCredential ??
      (await (async () => {
        const login = await verifiedGithubLoginFor(prisma, userId);
        return login ? lookupRepoPermission(repo, login) : null;
      })());
    if (!lookup) {
      return { ok: false, reason: 'no GitHub identity to check push permission against' };
    }
    if (!lookup.ok) {
      return {
        ok: false,
        reason: `GitHub push permission could not be confirmed (${lookup.failure})`,
      };
    }
    return permissionMeets(lookup.permission, 'write')
      ? { ok: true }
      : { ok: false, reason: 'GitHub reports no push access to this repository' };
  } catch {
    return { ok: false, reason: 'GitHub push permission could not be confirmed' };
  }
}
