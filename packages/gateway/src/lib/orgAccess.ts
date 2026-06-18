/**
 * Org-level RBAC helpers (P5).
 *
 * Platform ADMINs bypass all org checks. Non-admin users must have an
 * `OrganizationMembership` row to access org-scoped resources or submit work
 * requests to teams nested under that org.
 */
import type { PrismaClient } from '@auto-swe/shared';
import type { FastifyReply } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';

/**
 * Assert that `userId` is a member of `orgId`. Platform ADMINs short-circuit.
 * Sends a 403 reply and returns `false` if the check fails; returns `true` on success.
 * Intended for use in route handlers — call before reading/writing org data.
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
 * Assert that `userId` is an ORG_ADMIN of `orgId` (or platform ADMIN).
 * Returns false + sends 403 on failure.
 */
export async function assertOrgAdmin(
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
  if (membership?.role !== 'ORG_ADMIN') {
    await reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'Requires ORG_ADMIN role in this organization' },
    });
    return false;
  }
  return true;
}

/** Return all org IDs the user is a member of (empty array for platform ADMIN is handled by callers). */
export async function getUserOrgIds(prisma: PrismaClient, userId: string): Promise<string[]> {
  const rows = await prisma.organizationMembership.findMany({
    select: { orgId: true },
    where: { userId },
  });
  return rows.map((r: { orgId: string }) => r.orgId);
}

/** Compute the current calendar month as 'YYYY-MM'. */
export function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7);
}
