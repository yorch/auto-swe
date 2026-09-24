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
import { currentYearMonth } from '@auto-swe/shared/lib/billing';
import type { FastifyReply } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';

// Re-exported so callers (workRequests, orgBudget) keep importing it from this
// module; the implementation lives in @auto-swe/shared so the worker
// (OrgMonthlyUsage writer) and gateway (reader) share one formula.
export { currentYearMonth };

/** Error bodies for the two org-level refusals, shared with `authorizeLaunch`. */
export const ORG_ACCESS_REFUSAL = {
  code: 'FORBIDDEN',
  message: 'You are not a member of this organization',
} as const;

export function orgBudgetRefusal(budgetCap: number): { code: string; message: string } {
  return {
    code: 'ORG_BUDGET_EXCEEDED',
    message: `Organization has exceeded its monthly budget cap of ${budgetCap} USD cents`,
  };
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
 * **Best-effort under concurrency.** The check reads the committed spend and
 * nothing more: spend is recorded by the worker long after the launch returns,
 * so no lock taken here could serialise a launch against the spend it causes.
 * Two launches that arrive together both see the same pre-launch total, and a
 * burst can overshoot the cap by the cost of the runs already in flight. The cap
 * stops new work once spend is recorded; it is not a hard ceiling.
 */
export async function isOrgOverBudget(
  prisma: PrismaClient,
  orgId: string,
  budgetCap: number | null | undefined
): Promise<boolean> {
  if (budgetCap == null) {
    return false;
  }
  const usage = await prisma.orgMonthlyUsage.findUnique({
    where: { orgId_yearMonth: { orgId, yearMonth: currentYearMonth() } },
  });
  // costUsdAccrued is stored with micro-dollar precision (1e-6). Convert to
  // cents with a small epsilon so values like 9.9999999e-05 round correctly.
  const spentCents = Math.round(Number(usage?.costUsdAccrued ?? 0) * 100 + 1e-9);
  return spentCents >= budgetCap;
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
  await reply.status(402).send({ error: orgBudgetRefusal(budgetCap) });
  return false;
}
