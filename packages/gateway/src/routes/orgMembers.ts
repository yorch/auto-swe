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
import { requireAuth } from '../plugins/auth.js';

const OrgParamsSchema = z.object({ orgId: z.string().uuid() });
const MemberParamsSchema = z.object({ orgId: z.string().uuid(), userId: z.string().uuid() });

const UpsertMemberSchema = z.object({
  role: z.enum(['ORG_ADMIN', 'ORG_MEMBER']).default('ORG_MEMBER'),
  userId: z.string().uuid(),
});

const PatchMemberSchema = z.object({
  role: z.enum(['ORG_ADMIN', 'ORG_MEMBER']),
});

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
      await fastify.prisma.organizationMembership.delete({ where: { id: row.id } });
      return reply.status(204).send();
    }
  );
};

export const orgMembersRoutes = fp(orgMembersPlugin, {
  fastify: '5.x',
  name: 'org-members-routes',
});
