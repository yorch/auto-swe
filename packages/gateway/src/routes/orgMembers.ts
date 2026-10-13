/**
 * Org membership CRUD (P5 RBAC).
 * Mounted at /api/v1/platform/organizations.
 *
 * Access is enforced declaratively by the `requireAuth` onRequest hook:
 * `requiredOrgRole: 'ORG_MEMBER'` to read, `'ORG_ADMIN'` to write. Platform
 * ADMINs bypass the org check. This mirrors the team-scoped `requiredTeamRole`
 * pattern, so the gate is visible in each route's options rather than inline.
 */
import type { Prisma } from '@auto-swe/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { getDefaultClientOrigin } from '../lib/env.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

function memberAuditFields(row: { orgId: string; role: string; userId: string }) {
  return { orgId: row.orgId, role: row.role, userId: row.userId };
}

const OrgParamsSchema = z.object({ orgId: z.string().uuid() });
const MemberParamsSchema = z.object({ orgId: z.string().uuid(), userId: z.string().uuid() });

const UpsertMemberSchema = z.object({
  role: z.enum(['ORG_ADMIN', 'ORG_MEMBER']).default('ORG_MEMBER'),
  userId: z.string().uuid(),
});

const PatchMemberSchema = z.object({
  role: z.enum(['ORG_ADMIN', 'ORG_MEMBER']),
});

type OrgAdminGuardResult = { code: string; message: string } | null;

/** Prevent self-demotion/self-removal and removing/demoting the last org admin. */
async function guardOrgAdminChange(
  db: Prisma.TransactionClient,
  orgId: string,
  targetUserId: string,
  actorUserId: string,
  action: 'delete' | 'update',
  currentRole: 'ORG_ADMIN' | 'ORG_MEMBER',
  newRole?: 'ORG_ADMIN' | 'ORG_MEMBER'
): Promise<OrgAdminGuardResult> {
  if (actorUserId === targetUserId) {
    if (action === 'delete') {
      return { code: 'SELF_REMOVAL', message: 'Cannot remove yourself from the organization' };
    }
    if (newRole && newRole !== currentRole) {
      return { code: 'SELF_DEMOTION', message: 'Cannot change your own organization role' };
    }
  }
  if (
    currentRole === 'ORG_ADMIN' &&
    ((action === 'update' && newRole && newRole !== 'ORG_ADMIN') || action === 'delete')
  ) {
    const adminCount = await db.organizationMembership.count({
      where: { orgId, role: 'ORG_ADMIN' },
    });
    if (adminCount <= 1) {
      return {
        code: 'LAST_ORG_ADMIN',
        message: 'Cannot remove or demote the last organization admin',
      };
    }
  }
  return null;
}

async function withOrganizationMembershipLock<T>(
  fastify: Parameters<typeof orgMembersPlugin>[0],
  orgId: string,
  write: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return fastify.prisma.$transaction(async (tx) => {
    // CLAUDE.md §7 exception: serialize org membership writes with source checks and revocations.
    await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`;
    return write(tx);
  });
}

const orgMembersPlugin: FastifyPluginAsync = async (fastify) => {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/platform/organizations/:orgId/members
  f.get(
    '/:orgId/members',
    {
      onRequest: requireAuth({ orgIdParam: 'orgId', requiredOrgRole: 'ORG_MEMBER' }),
      schema: { params: OrgParamsSchema },
    },
    async (request) => {
      const { orgId } = request.params;
      const rows = await fastify.prisma.organizationMembership.findMany({
        include: { user: { select: { email: true, id: true, name: true, role: true } } },
        orderBy: { createdAt: 'asc' },
        where: { orgId },
      });
      return {
        data: rows.map((r) => ({
          createdAt: r.createdAt,
          id: r.id,
          orgId: r.orgId,
          role: r.role,
          user: r.user,
          userId: r.userId,
        })),
      };
    }
  );

  // POST /api/v1/platform/organizations/:orgId/members
  f.post(
    '/:orgId/members',
    {
      onRequest: requireAuth({ orgIdParam: 'orgId', requiredOrgRole: 'ORG_ADMIN' }),
      schema: { body: UpsertMemberSchema, params: OrgParamsSchema },
    },
    async (request, reply) => {
      const { orgId } = request.params;
      const { userId, role } = request.body;

      const result = await withOrganizationMembershipLock(fastify, orgId, async (tx) => {
        const existing = await tx.organizationMembership.findUnique({
          where: { userId_orgId: { orgId, userId } },
        });
        if (existing) {
          const guard = await guardOrgAdminChange(
            tx,
            orgId,
            userId,
            requireUser(request).sub,
            'update',
            existing.role,
            role
          );
          if (guard) {
            return { guard };
          }
          const updated = await tx.organizationMembership.update({
            data: { role },
            where: { id: existing.id },
          });
          await writeAuditLog(fastify, {
            action: 'UPDATE',
            actor: requireUser(request),
            after: memberAuditFields(updated),
            before: memberAuditFields(existing),
            client: tx,
            entityId: existing.id,
            entityType: 'OrganizationMembership',
          });
          return { status: 200 as const, value: updated };
        }
        const created = await tx.organizationMembership.create({
          data: { orgId, role, userId },
        });
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor: requireUser(request),
          after: memberAuditFields(created),
          client: tx,
          entityId: created.id,
          entityType: 'OrganizationMembership',
        });
        return { status: 201 as const, value: created };
      });
      if ('guard' in result && result.guard) {
        return reply
          .status(409)
          .send({ error: { code: result.guard.code, message: result.guard.message } });
      }
      return reply.status(result.status).send({ data: result.value });
    }
  );

  // POST /api/v1/platform/organizations/:orgId/members/invite
  f.post(
    '/:orgId/members/invite',
    {
      onRequest: requireAuth({ orgIdParam: 'orgId', requiredOrgRole: 'ORG_ADMIN' }),
      schema: {
        body: z.object({
          email: z.string().trim().toLowerCase().email(),
          orgRole: z.enum(['ORG_ADMIN', 'ORG_MEMBER']).default('ORG_MEMBER'),
        }),
        params: OrgParamsSchema,
      },
    },
    async (request, reply) => {
      const { orgId } = request.params;
      const { email, orgRole } = request.body;

      const existing = await fastify.prisma.user.findFirst({
        where: { email: { equals: email, mode: 'insensitive' } },
      });
      if (existing) {
        return reply
          .status(409)
          .send({ error: { code: 'USER_EXISTS', message: 'User with this email already exists' } });
      }

      const user = await fastify.prisma.user.create({
        data: {
          email,
          emailVerified: true,
          isActive: true,
          role: 'ENGINEER',
        },
        select: { email: true, id: true, isActive: true, role: true },
      });
      await withOrganizationMembershipLock(fastify, orgId, async (tx) => {
        const created = await tx.organizationMembership.create({
          data: { orgId, role: orgRole, userId: user.id },
        });
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor: requireUser(request),
          after: memberAuditFields(created),
          client: tx,
          entityId: created.id,
          entityType: 'OrganizationMembership',
        });
      });

      try {
        const { getAuth } = await import('../lib/betterAuth.js');
        const clientOrigin = getDefaultClientOrigin();
        await getAuth().api.signInMagicLink({
          body: { callbackURL: `${clientOrigin}/login?bridge=1`, email },
          headers: new Headers(),
        });
      } catch (err) {
        fastify.log.warn({ err }, 'org invite magic-link send failed — user row was created');
      }

      return reply.status(201).send({
        data: { ...user, orgRole },
      });
    }
  );

  // PATCH /api/v1/platform/organizations/:orgId/members/:userId
  f.patch(
    '/:orgId/members/:userId',
    {
      onRequest: requireAuth({ orgIdParam: 'orgId', requiredOrgRole: 'ORG_ADMIN' }),
      schema: { body: PatchMemberSchema, params: MemberParamsSchema },
    },
    async (request, reply) => {
      const { orgId, userId } = request.params;
      const { role } = request.body;

      const result = await withOrganizationMembershipLock(fastify, orgId, async (tx) => {
        const row = await tx.organizationMembership.findUnique({
          where: { userId_orgId: { orgId, userId } },
        });
        if (!row) {
          return { missing: true as const };
        }
        const guard = await guardOrgAdminChange(
          tx,
          orgId,
          userId,
          requireUser(request).sub,
          'update',
          row.role,
          role
        );
        if (guard) {
          return { guard };
        }
        const updated = await tx.organizationMembership.update({
          data: { role },
          where: { id: row.id },
        });
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: requireUser(request),
          after: memberAuditFields(updated),
          before: memberAuditFields(row),
          client: tx,
          entityId: row.id,
          entityType: 'OrganizationMembership',
        });
        return { value: updated };
      });
      if ('missing' in result) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Membership not found' } });
      }
      if ('guard' in result && result.guard) {
        return reply
          .status(409)
          .send({ error: { code: result.guard.code, message: result.guard.message } });
      }
      return { data: result.value };
    }
  );

  // DELETE /api/v1/platform/organizations/:orgId/members/:userId
  f.delete(
    '/:orgId/members/:userId',
    {
      onRequest: requireAuth({ orgIdParam: 'orgId', requiredOrgRole: 'ORG_ADMIN' }),
      schema: { params: MemberParamsSchema },
    },
    async (request, reply) => {
      const { orgId, userId } = request.params;

      const result = await withOrganizationMembershipLock(fastify, orgId, async (tx) => {
        const row = await tx.organizationMembership.findUnique({
          where: { userId_orgId: { orgId, userId } },
        });
        if (!row) {
          return { missing: true as const };
        }
        const guard = await guardOrgAdminChange(
          tx,
          orgId,
          userId,
          requireUser(request).sub,
          'delete',
          row.role
        );
        if (guard) {
          return { guard };
        }
        await tx.organizationMembership.delete({ where: { id: row.id } });
        await writeAuditLog(fastify, {
          action: 'DELETE',
          actor: requireUser(request),
          before: memberAuditFields(row),
          client: tx,
          entityId: row.id,
          entityType: 'OrganizationMembership',
        });
        return { deleted: true as const };
      });
      if ('missing' in result) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Membership not found' } });
      }
      if ('guard' in result && result.guard) {
        return reply
          .status(409)
          .send({ error: { code: result.guard.code, message: result.guard.message } });
      }
      return reply.status(204).send();
    }
  );
};

// Deliberately NOT wrapped in fastify-plugin: `fp()` sets skip-override, and
// Fastify then ignores the `prefix` passed at registration, mounting these
// routes at the server root instead of under /api/v1/admin/organizations.
// The plugin decorates nothing, so encapsulation is exactly what it needs.
export const orgMembersRoutes: FastifyPluginAsync = orgMembersPlugin;
