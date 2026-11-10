/**
 * Org-level RBAC and budget helpers.
 *
 * Most org-scoped routes enforce access declaratively via the `requireAuth`
 * onRequest hook (`requiredOrgRole` + `orgIdParam`). These cover the case the
 * hook can't: a launch, where the org is derived from the target connection
 * inside the handler rather than from a route param. Launch routes reach them
 * through `authorizeLaunch` (`launchAuthorization.ts`).
 *
 * Platform ADMINs bypass the check; non-admins need an `OrganizationMembership`
 * row for the org.
 */
import type { PrismaClient } from '@auto-swe/shared';
import {
  currentYearMonth,
  isTeamOverBudget,
  orgMonthSpend,
  usdToCents,
} from '@auto-swe/shared/lib/billing';
import type { FastifyReply } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';

// Re-exported so callers (workRequests, orgBudget) keep importing it from this
// module; the implementation lives in @auto-swe/shared so the worker
// (OrgMonthlyUsage writer) and gateway (reader) share one formula.
export { currentYearMonth, isTeamOverBudget };

/** Error bodies for the two org-level refusals, shared with `authorizeLaunch`. */
export const ORG_ACCESS_REFUSAL = {
  code: 'FORBIDDEN',
  message: 'You are not a member of this organization',
} as const;

/**
 * The 402 body. It names the state and not the cap: the amount is an ORG_ADMIN's to read, and a
 * refused engineer needs to know the budget is spent, not by how much.
 */
export function orgBudgetRefusal(): { code: string; message: string } {
  return {
    code: 'ORG_BUDGET_EXCEEDED',
    message: 'Organization has exceeded its monthly budget cap',
  };
}

/**
 * The 402 body for a team's own cap. It carries no amount, and it names the team only when the
 * caller is a member of it: a sharee launching on another team's repository is told that the
 * owning team's budget is spent, not whose it is.
 */
export function teamBudgetRefusal(team: { memberName: string | null }): {
  code: string;
  message: string;
} {
  return {
    code: 'TEAM_BUDGET_EXCEEDED',
    message: team.memberName
      ? `Team "${team.memberName}" has exceeded its monthly budget cap`
      : 'The team that owns this repository has exceeded its monthly budget cap',
  };
}

/** Is the user an ORG_ADMIN of `orgId`? Platform ADMINs always are. */
export async function isOrgAdmin(
  prisma: PrismaClient,
  user: { role: string; sub: string },
  orgId: string
): Promise<boolean> {
  if (user.role === 'ADMIN') {
    return true;
  }
  const membership = await prisma.organizationMembership.findUnique({
    where: { userId_orgId: { orgId, userId: user.sub } },
  });
  return membership?.role === 'ORG_ADMIN';
}

/** Is the user a member of `orgId`? Platform ADMINs always are. */
export async function isOrgMember(
  prisma: PrismaClient,
  user: Pick<JwtPayload, 'role' | 'sub'>,
  orgId: string
): Promise<boolean> {
  if (user.role === 'ADMIN') {
    return true;
  }
  const membership = await prisma.organizationMembership.findUnique({
    where: { userId_orgId: { orgId, userId: user.sub } },
  });
  return membership !== null;
}

/**
 * Has `orgId` spent its monthly cap? `false` when no cap is configured.
 *
 * Spend is {@link orgMonthSpend}: finalized runs, plus what runs still in
 * flight have accrued so far, plus runless workflows attributed to the org — so
 * a burst of long runs is stopped by the spend it has already made, not only
 * once those runs finalize.
 *
 * **Still best-effort under concurrency.** Spend is recorded by the worker
 * after the launch returns, so no lock taken here could serialise a launch
 * against the spend it causes. Two launches that arrive together both see the
 * same total, and each run can still spend after the cap is reached. The cap
 * stops new work; it is not a hard ceiling.
 */
export async function isOrgOverBudget(
  prisma: PrismaClient,
  orgId: string,
  budgetCap: number | null | undefined
): Promise<boolean> {
  if (budgetCap == null) {
    return false;
  }
  const { totalUsd } = await orgMonthSpend(prisma, orgId);
  return usdToCents(totalUsd) >= budgetCap;
}

/**
 * Assert that the user is a member of `orgId` (platform ADMINs short-circuit).
 * Sends a 403 reply and returns `false` if the check fails; returns `true` on success.
 */
export async function assertOrgAccess(
  prisma: PrismaClient,
  user: JwtPayload,
  orgId: string,
  reply: FastifyReply
): Promise<boolean> {
  if (await isOrgMember(prisma, user, orgId)) {
    return true;
  }
  await reply.status(403).send({ error: ORG_ACCESS_REFUSAL });
  return false;
}

/**
 * Assert that `orgId` has not exceeded its monthly budget cap. Sends a 402
 * reply and returns `false` if the current month's accrued cost meets or
 * exceeds `budgetCap`; returns `true` otherwise (including when `budgetCap`
 * is `null`/`undefined`, meaning no cap is configured). Best-effort under
 * concurrency — see {@link isOrgOverBudget}.
 */
export async function assertOrgBudget(
  prisma: PrismaClient,
  orgId: string,
  budgetCap: number | null | undefined,
  reply: FastifyReply
): Promise<boolean> {
  if (budgetCap == null || !(await isOrgOverBudget(prisma, orgId, budgetCap))) {
    return true;
  }
  await reply.status(402).send({ error: orgBudgetRefusal() });
  return false;
}

/**
 * Assert that a team has not exhausted its own monthly cap (see `isTeamOverBudget`). Sends the 402
 * reply and returns `false` when it has; `true` otherwise, including with no cap. For a launch
 * with no authenticated caller (a webhook), where `authorizeLaunch` is not taken; `memberName` is
 * null there because no caller can be a member.
 */
export async function assertTeamBudget(
  prisma: PrismaClient,
  team: { id: string; monthlyBudgetUsdCents: number | null | undefined },
  reply: FastifyReply
): Promise<boolean> {
  if (team.monthlyBudgetUsdCents == null) {
    return true;
  }
  if (!(await isTeamOverBudget(prisma, team.id, team.monthlyBudgetUsdCents))) {
    return true;
  }
  await reply.status(402).send({ error: teamBudgetRefusal({ memberName: null }) });
  return false;
}
