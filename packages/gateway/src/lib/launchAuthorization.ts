/**
 * The one authorization decision every launch path takes.
 *
 * A launch — a work request, a re-run, an epic, a PRD run, a schedule, the Slack
 * run modal, a template run — pushes branches, opens pull requests and spends an
 * organization's budget. Each of those used to spell out the same sequence by
 * hand: repository access, then org membership, then the org's monthly cap. Seven
 * copies drifted: PRD runs, schedules, template runs and the Slack modal each
 * shipped without one or both org checks, and a schedule could be re-activated
 * without the repository decision at all.
 *
 * `authorizeLaunch` is that sequence, once. It decides without sending anything
 * so an HTTP route and a Slack view submission can render the same refusal in
 * their own shape.
 */
import type { PrismaClient } from '@auto-swe/shared';
import type { AccessActor, AccessLog } from '@auto-swe/shared/lib/accessActor';
import {
  decideRepoAccess,
  multiRepoRefusalBody,
  type RepoAccessRefusal,
  type RepoAccessSubject,
  repoAccessErrorBody,
} from '@auto-swe/shared/lib/repoAccessDecision';
import type { RepoAccessGate } from '@auto-swe/shared/lib/repoAccessGate';
import type { FastifyReply } from 'fastify';
import { isOrgMember, isOrgOverBudget, ORG_ACCESS_REFUSAL, orgBudgetRefusal } from './orgAccess.js';

/** The org a launch spends against. */
export interface LaunchOrg {
  id: string;
  monthlyBudgetUsdCents: number | null;
}

/**
 * A repository a launch acts on: everything the repository decision reads, plus
 * the owning org so membership and the cap can be checked. Required fields, so a
 * route whose `select` drops the org fails to compile rather than skipping the
 * org checks.
 */
export interface LaunchRepo extends RepoAccessSubject {
  team: RepoAccessSubject['team'] & {
    orgId: string;
    organization: { monthlyBudgetUsdCents: number | null } | null;
  };
}

export type LaunchRefusalKind = 'repo-access' | 'org-access' | 'org-budget';

export interface LaunchRefusal {
  kind: LaunchRefusalKind;
  status: 402 | 403;
  /** The gateway's error envelope, ready to send. */
  body: { error: { code: string; message: string } & Record<string, unknown> };
}

export type LaunchDecision = { ok: true } | { ok: false; refusal: LaunchRefusal };

export interface AuthorizeLaunchInput {
  repos: LaunchRepo[];
  /**
   * Orgs the run spends against that no repository names — a template run with
   * no connection spends its template team's org.
   */
  orgs?: LaunchOrg[];
  /** Required-but-nullable, like every other gate argument: undefined means off. */
  gate: RepoAccessGate | undefined;
  log?: AccessLog;
  /**
   * `multi` names every refused repository (epics, PRD runs); `single` is the
   * one-repository body. Defaults to `multi` when more than one repo is given.
   */
  refusalShape?: 'single' | 'multi';
}

/**
 * May `actor` start this launch? Repository access (team membership, GitHub
 * permission, installation retirement) for every repo, then membership of every
 * org the launch spends against, then each org's monthly cap.
 *
 * The order matters for what a refusal says: someone outside the team is told
 * that, rather than about an org budget they have no stake in.
 */
export async function authorizeLaunch(
  prisma: PrismaClient,
  actor: AccessActor,
  input: AuthorizeLaunchInput
): Promise<LaunchDecision> {
  const gate = input.gate ?? { mode: 'off', staleAfterHours: 0 };

  const refusals: Array<{ label: string; reason: RepoAccessRefusal }> = [];
  for (const repo of input.repos) {
    const decision = await decideRepoAccess(prisma, actor, repo, gate, input.log);
    if (!decision.allowed) {
      refusals.push({
        label: `${repo.organizationName ?? '?'}/${repo.repoName ?? repo.id}`,
        reason: decision.reason,
      });
    }
  }
  if (refusals.length > 0) {
    const shape = input.refusalShape ?? (input.repos.length > 1 ? 'multi' : 'single');
    return {
      ok: false,
      refusal: {
        body:
          shape === 'multi'
            ? multiRepoRefusalBody(refusals)
            : repoAccessErrorBody((refusals[0] as { reason: RepoAccessRefusal }).reason),
        kind: 'repo-access',
        status: 403,
      },
    };
  }

  const orgs = new Map<string, number | null>();
  for (const repo of input.repos) {
    if (!orgs.has(repo.team.orgId)) {
      orgs.set(repo.team.orgId, repo.team.organization?.monthlyBudgetUsdCents ?? null);
    }
  }
  for (const org of input.orgs ?? []) {
    if (!orgs.has(org.id)) {
      orgs.set(org.id, org.monthlyBudgetUsdCents);
    }
  }

  for (const orgId of orgs.keys()) {
    if (!(await isOrgMember(prisma, actor, orgId))) {
      return {
        ok: false,
        refusal: { body: { error: { ...ORG_ACCESS_REFUSAL } }, kind: 'org-access', status: 403 },
      };
    }
  }
  for (const [orgId, cap] of orgs) {
    if (cap != null && (await isOrgOverBudget(prisma, orgId, cap))) {
      return {
        ok: false,
        refusal: { body: { error: orgBudgetRefusal(cap) }, kind: 'org-budget', status: 402 },
      };
    }
  }
  return { ok: true };
}

/** Send a refusal from {@link authorizeLaunch} as the HTTP response. */
export function sendLaunchRefusal(reply: FastifyReply, refusal: LaunchRefusal): FastifyReply {
  return reply.status(refusal.status).send(refusal.body);
}

/** Refusal text for surfaces that show one line (Slack view errors). */
export function launchRefusalMessage(refusal: LaunchRefusal): string {
  return refusal.body.error.message;
}
