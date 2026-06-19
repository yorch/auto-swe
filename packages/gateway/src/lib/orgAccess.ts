/**
 * Org-level RBAC helpers (P5).
 *
 * Platform ADMINs bypass all org checks. Non-admin users must have an
 * `OrganizationMembership` row to access org-scoped resources or submit work
 * requests to teams nested under that org.
 */
import type { PrismaClient } from '@auto-swe/shared';
import { currentYearMonth } from '@auto-swe/shared/lib/billing';
import type { FastifyReply } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';

// Re-exported so existing callers (workRequests, orgBudget) keep importing it
// from the org-access module; the implementation lives in @auto-swe/shared so
// the worker (OrgMonthlyUsage writer) and gateway (reader) share one formula.
export { currentYearMonth };

/**
 * Resolve the requesting user's standing in `orgId`. Platform ADMINs are
 * reported with `isPlatformAdmin: true` and skip the membership lookup. Shared
 * by both assert helpers so the bypass + lookup live in one place.
 */
async function loadOrgStanding(
  prisma: PrismaClient,
  user: JwtPayload,
  orgId: string
): Promise<{ isPlatformAdmin: boolean; role: string | null }> {
  if (user.role === 'ADMIN') {
    return { isPlatformAdmin: true, role: null };
  }
  const membership = await prisma.organizationMembership.findUnique({
    where: { userId_orgId: { orgId, userId: user.sub } },
  });
  return { isPlatformAdmin: false, role: membership?.role ?? null };
}

/**
 * Assert that the user is a member of `orgId` (platform ADMINs short-circuit).
 * Sends a 403 reply and returns `false` if the check fails; returns `true` on success.
 * Intended for use in route handlers — call before reading/writing org data.
 */
export async function assertOrgAccess(
  prisma: PrismaClient,
  user: JwtPayload,
  orgId: string,
  reply: FastifyReply
): Promise<boolean> {
  const { isPlatformAdmin, role } = await loadOrgStanding(prisma, user, orgId);
  if (isPlatformAdmin || role) {
    return true;
  }
  await reply.status(403).send({
    error: { code: 'FORBIDDEN', message: 'You are not a member of this organization' },
  });
  return false;
}

/**
 * Assert that the user is an ORG_ADMIN of `orgId` (or platform ADMIN).
 * Returns false + sends 403 on failure.
 */
export async function assertOrgAdmin(
  prisma: PrismaClient,
  user: JwtPayload,
  orgId: string,
  reply: FastifyReply
): Promise<boolean> {
  const { isPlatformAdmin, role } = await loadOrgStanding(prisma, user, orgId);
  if (isPlatformAdmin || role === 'ORG_ADMIN') {
    return true;
  }
  await reply.status(403).send({
    error: { code: 'FORBIDDEN', message: 'Requires ORG_ADMIN role in this organization' },
  });
  return false;
}
