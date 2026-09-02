/**
 * Org membership CRUD (P5 RBAC).
 * Mounted at /api/v1/admin/organizations.
 *
 * Access is enforced declaratively by the `requireAuth` onRequest hook:
 * `requiredOrgRole: 'ORG_MEMBER'` to read, `'ORG_ADMIN'` to write. Platform
 * ADMINs bypass the org check. This mirrors the team-scoped `requiredTeamRole`
 * pattern, so the gate is visible in each route's options rather than inline.
 */
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getDefaultClientOrigin } from '../lib/env.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

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
  fastify: Parameters<typeof orgMembersPlugin>[0],
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
    const adminCount = await fastify.prisma.organizationMembership.count({
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

const orgMembersPlugin: FastifyPluginAsync = async (fastify) => {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/admin/organizations/:orgId/members
  f.get(
    '/:orgId/members',
    { onRequest: requireAuth({ orgIdParam: 'orgId', requiredOrgRole: 'ORG_MEMBER' }) },
    async (request) => {
      const { orgId } = OrgParamsSchema.parse(request.params);
      const rows = await fastify.prisma.organizationMembership.findMany({
        include: { user: { select: { email: true, id: true, name: true, role: true } } },
        orderBy: { createdAt: 'asc' },
        where: { orgId },
      });
      return rows.map((r) => ({
        createdAt: r.createdAt,
        id: r.id,
        orgId: r.orgId,
        role: r.role,
        user: r.user,
        userId: r.userId,
      }));
    }
  );

  // POST /api/v1/admin/organizations/:orgId/members
  f.post(
    '/:orgId/members',
    {
      onRequest: requireAuth({ orgIdParam: 'orgId', requiredOrgRole: 'ORG_ADMIN' }),
      schema: { body: UpsertMemberSchema, params: OrgParamsSchema },
    },
    async (request, reply) => {
      const { orgId } = OrgParamsSchema.parse(request.params);
      const { userId, role } = UpsertMemberSchema.parse(request.body);

      const existing = await fastify.prisma.organizationMembership.findUnique({
        where: { userId_orgId: { orgId, userId } },
      });
      if (existing) {
        const guard = await guardOrgAdminChange(
          fastify,
          orgId,
          userId,
          requireUser(request).sub,
          'update',
          existing.role,
          role
        );
        if (guard) {
          return reply.status(409).send({ error: { code: guard.code, message: guard.message } });
        }
        const updated = await fastify.prisma.organizationMembership.update({
          data: { role },
          where: { id: existing.id },
        });
        return reply.status(200).send(updated);
      }
      const created = await fastify.prisma.organizationMembership.create({
        data: { orgId, role, userId },
      });
      return reply.status(201).send(created);
    }
  );

  // POST /api/v1/admin/organizations/:orgId/members/invite
  f.post(
    '/:orgId/members/invite',
    {
      onRequest: requireAuth({ orgIdParam: 'orgId', requiredOrgRole: 'ORG_ADMIN' }),
      schema: {
        body: z.object({
          email: z.string().email(),
          orgRole: z.enum(['ORG_ADMIN', 'ORG_MEMBER']).default('ORG_MEMBER'),
        }),
        params: OrgParamsSchema,
      },
    },
    async (request, reply) => {
      const { orgId } = OrgParamsSchema.parse(request.params);
      const { email, orgRole } = request.body;

      const existing = await fastify.prisma.user.findUnique({ where: { email } });
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
      await fastify.prisma.organizationMembership.create({
        data: { orgId, role: orgRole, userId: user.id },
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

  // PATCH /api/v1/admin/organizations/:orgId/members/:userId
  f.patch(
    '/:orgId/members/:userId',
    {
      onRequest: requireAuth({ orgIdParam: 'orgId', requiredOrgRole: 'ORG_ADMIN' }),
      schema: { body: PatchMemberSchema, params: MemberParamsSchema },
    },
    async (request, reply) => {
      const { orgId, userId } = MemberParamsSchema.parse(request.params);
      const { role } = PatchMemberSchema.parse(request.body);

      const row = await fastify.prisma.organizationMembership.findUnique({
        where: { userId_orgId: { orgId, userId } },
      });
      if (!row) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Membership not found' } });
      }
      const guard = await guardOrgAdminChange(
        fastify,
        orgId,
        userId,
        requireUser(request).sub,
        'update',
        row.role,
        role
      );
      if (guard) {
        return reply.status(409).send({ error: { code: guard.code, message: guard.message } });
      }
      const updated = await fastify.prisma.organizationMembership.update({
        data: { role },
        where: { id: row.id },
      });
      return updated;
    }
  );

  // DELETE /api/v1/admin/organizations/:orgId/members/:userId
  f.delete(
    '/:orgId/members/:userId',
    {
      onRequest: requireAuth({ orgIdParam: 'orgId', requiredOrgRole: 'ORG_ADMIN' }),
      schema: { params: MemberParamsSchema },
    },
    async (request, reply) => {
      const { orgId, userId } = MemberParamsSchema.parse(request.params);

      const row = await fastify.prisma.organizationMembership.findUnique({
        where: { userId_orgId: { orgId, userId } },
      });
      if (!row) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Membership not found' } });
      }
      const guard = await guardOrgAdminChange(
        fastify,
        orgId,
        userId,
        requireUser(request).sub,
        'delete',
        row.role
      );
      if (guard) {
        return reply.status(409).send({ error: { code: guard.code, message: guard.message } });
      }
      await fastify.prisma.organizationMembership.delete({ where: { id: row.id } });
      return reply.status(204).send();
    }
  );
};

export const orgMembersRoutes = fp(orgMembersPlugin, {
  fastify: '5.x',
  name: 'org-members-routes',
});
