/**
 * Org-level RBAC helper (P5).
 *
 * Most org-scoped routes enforce access declaratively via the `requireAuth`
 * onRequest hook (`requiredOrgRole` + `orgIdParam`). This helper covers the one
 * case the hook can't: work-request submission, where the org is derived from
 * the target connection inside the handler rather than from a route param.
 *
 * Platform ADMINs bypass the check; non-admins need an `OrganizationMembership`
 * row for the org.
 */
import { Prisma, type PrismaClient } from '@auto-swe/shared';
import { currentYearMonth } from '@auto-swe/shared/lib/billing';
import type { FastifyReply } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';

// Re-exported so callers (workRequests, orgBudget) keep importing it from this
// module; the implementation lives in @auto-swe/shared so the worker
// (OrgMonthlyUsage writer) and gateway (reader) share one formula.
export { currentYearMonth };

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
  if (user.role === 'ADMIN') {
    return true;
  }
  const membership = await prisma.organizationMembership.findUnique({
    where: { userId_orgId: { orgId, userId: user.sub } },
  });
  if (!membership) {
    await reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'You are not a member of this organization' },
    });
    return false;
  }
  return true;
}

/**
 * Serialize budget-cap checks for a single org with a PostgreSQL advisory
 * xact lock. The check is read-only, but concurrent launches read the same
 * `org_monthly_usage` row and could each pass before any finalize writes —
 * the lock turns that into one allowed launch at a time.
 */
async function lockOrgBudget(prisma: PrismaClient, orgId: string): Promise<void> {
  await prisma.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${orgId}, 0))
  `);
}

/**
 * Assert that `orgId` has not exceeded its monthly budget cap. Sends a 402
 * reply and returns `false` if the current month's accrued cost meets or
 * exceeds `budgetCap`; returns `true` otherwise (including when `budgetCap`
 * is `null`/`undefined`, meaning no cap is configured).
 *
 * The check is performed under a per-org advisory lock so concurrent launches
 * see the latest committed spend.
 */
export async function assertOrgBudget(
  prisma: PrismaClient,
  orgId: string,
  budgetCap: number | null | undefined,
  reply: FastifyReply
): Promise<boolean> {
  if (budgetCap == null) {
    return true;
  }
  await lockOrgBudget(prisma, orgId);
  const usage = await prisma.orgMonthlyUsage.findUnique({
    where: { orgId_yearMonth: { orgId, yearMonth: currentYearMonth() } },
  });
  // costUsdAccrued is stored with micro-dollar precision (1e-6). Convert to
  // cents with a small epsilon so values like 9.9999999e-05 round correctly.
  const spentCents = Math.round(Number(usage?.costUsdAccrued ?? 0) * 100 + 1e-9);
  if (spentCents >= budgetCap) {
    await reply.status(402).send({
      error: {
        code: 'ORG_BUDGET_EXCEEDED',
        message: `Organization has exceeded its monthly budget cap of ${budgetCap} USD cents`,
      },
    });
    return false;
  }
  return true;
}
