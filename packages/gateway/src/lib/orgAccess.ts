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
import type { PrismaClient } from '@auto-swe/shared';
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
