import type { Prisma } from '@auto-swe/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requireUser } from '../plugins/auth.js';

const CreateTeamSchema = z.object({
  description: z.string().max(500).default(''),
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase-kebab-case'),
});

const UpdateTeamSchema = z.object({
  description: z.string().max(500).optional(),
  name: z.string().min(1).max(100).optional(),
});

const TeamParamsSchema = z.object({ id: z.string().uuid() });
const TeamMemberParamsSchema = z.object({ id: z.string().uuid(), userId: z.string().uuid() });

const AddMemberSchema = z.object({
  role: z.enum(['ADMIN', 'LEAD', 'ENGINEER']).default('ENGINEER'),
  userId: z.string().uuid(),
});

const UpdateMemberSchema = z.object({
  role: z.enum(['ADMIN', 'LEAD', 'ENGINEER']),
});

export const teamRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // POST /api/v1/teams — Create team (ADMIN only)
  app.post(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { body: CreateTeamSchema },
    },
    async (request, reply) => {
      const { name, slug, description } = request.body;

      const existing = await fastify.prisma.team.findFirst({
        where: { OR: [{ name }, { slug }] },
      });
      if (existing) {
        return reply.status(409).send({
          error: { code: 'TEAM_EXISTS', message: 'Team name or slug already exists' },
        });
      }

      const team = await fastify.prisma.team.create({
        data: { description, name, slug },
      });

      return reply.status(201).send({ data: team });
    }
  );

  // GET /api/v1/teams — List teams
  app.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
    },
    async (request) => {
      const user = requireUser(request);
      const where: Prisma.TeamWhereInput = {
        isActive: true,
        ...(user.role !== 'ADMIN' && {
          memberships: { some: { userId: user.sub } },
        }),
      };

      const teams = await fastify.prisma.team.findMany({
        include: {
          _count: { select: { memberships: true, repositories: true } },
        },
        orderBy: { name: 'asc' },
        where,
      });

      return { data: teams };
    }
  );

  // GET /api/v1/teams/:id — Team detail
  app.get<{ Params: { id: string } }>(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
    },
    async (request, reply) => {
      const user = requireUser(request);

      const team = await fastify.prisma.team.findUnique({
        include: {
          memberships: { include: { user: { select: { email: true, id: true, role: true } } } },
          repositories: {
            select: { id: true, isActive: true, organizationName: true, repoName: true },
          },
        },
        where: { id: request.params.id },
      });

      if (!team) {
        return reply.status(404).send({
          error: { code: 'TEAM_NOT_FOUND', message: 'Team not found' },
        });
      }

      // Non-admins may only view teams they belong to
      if (user.role !== 'ADMIN') {
        const isMember = team.memberships.some((m) => m.user.id === user.sub);
        if (!isMember) {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'You are not a member of this team' },
          });
        }
      }

      return { data: team };
    }
  );

  // PATCH /api/v1/teams/:id — Update team (requires LEAD in this team)
  app.patch(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD', requiredTeamRole: 'LEAD', teamIdParam: 'id' }),
      schema: { body: UpdateTeamSchema, params: TeamParamsSchema },
    },
    async (request, reply) => {
      const team = await fastify.prisma.team.findUnique({
        where: { id: request.params.id },
      });
      if (!team) {
        return reply.status(404).send({
          error: { code: 'TEAM_NOT_FOUND', message: 'Team not found' },
        });
      }

      const updated = await fastify.prisma.team.update({
        data: request.body,
        where: { id: request.params.id },
      });

      return { data: updated };
    }
  );

  // DELETE /api/v1/teams/:id — Soft-delete team (ADMIN only)
  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
    },
    async (request, reply) => {
      const team = await fastify.prisma.team.findUnique({
        where: { id: request.params.id },
      });
      if (!team) {
        return reply.status(404).send({
          error: { code: 'TEAM_NOT_FOUND', message: 'Team not found' },
        });
      }

      await fastify.prisma.team.update({
        data: { isActive: false },
        where: { id: request.params.id },
      });

      return { data: { deleted: true } };
    }
  );

  // ── Team Members ──

  // GET /api/v1/teams/:id/members
  app.get<{ Params: { id: string } }>(
    '/:id/members',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
    },
    async (request, reply) => {
      const team = await fastify.prisma.team.findUnique({
        where: { id: request.params.id },
      });
      if (!team) {
        return reply.status(404).send({
          error: { code: 'TEAM_NOT_FOUND', message: 'Team not found' },
        });
      }

      const members = await fastify.prisma.teamMembership.findMany({
        include: {
          user: { select: { email: true, id: true, isActive: true, role: true, slackId: true } },
        },
        orderBy: { createdAt: 'asc' },
        where: { teamId: request.params.id },
      });

      return { data: members };
    }
  );

  // POST /api/v1/teams/:id/members — Add member (requires LEAD in this team)
  app.post(
    '/:id/members',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD', requiredTeamRole: 'LEAD', teamIdParam: 'id' }),
      schema: { body: AddMemberSchema, params: TeamParamsSchema },
    },
    async (request, reply) => {
      const { userId, role } = request.body;

      const existing = await fastify.prisma.teamMembership.findUnique({
        where: { userId_teamId: { teamId: request.params.id, userId } },
      });
      if (existing) {
        return reply.status(409).send({
          error: { code: 'MEMBER_EXISTS', message: 'User is already a member of this team' },
        });
      }

      const membership = await fastify.prisma.teamMembership.create({
        data: {
          role,
          teamId: request.params.id,
          userId,
        },
        include: { user: { select: { email: true, id: true, role: true } } },
      });

      return reply.status(201).send({ data: membership });
    }
  );

  // PATCH /api/v1/teams/:id/members/:userId — Update member role (requires LEAD in this team)
  app.patch(
    '/:id/members/:userId',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD', requiredTeamRole: 'LEAD', teamIdParam: 'id' }),
      schema: { body: UpdateMemberSchema, params: TeamMemberParamsSchema },
    },
    async (request, reply) => {
      const membership = await fastify.prisma.teamMembership.findUnique({
        where: { userId_teamId: { teamId: request.params.id, userId: request.params.userId } },
      });
      if (!membership) {
        return reply.status(404).send({
          error: { code: 'MEMBER_NOT_FOUND', message: 'Membership not found' },
        });
      }

      const updated = await fastify.prisma.teamMembership.update({
        data: { role: request.body.role },
        where: { id: membership.id },
      });

      return { data: updated };
    }
  );

  // DELETE /api/v1/teams/:id/members/:userId — Remove member (requires LEAD in this team)
  app.delete<{ Params: { id: string; userId: string } }>(
    '/:id/members/:userId',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD', requiredTeamRole: 'LEAD', teamIdParam: 'id' }),
    },
    async (request, reply) => {
      const membership = await fastify.prisma.teamMembership.findUnique({
        where: { userId_teamId: { teamId: request.params.id, userId: request.params.userId } },
      });
      if (!membership) {
        return reply.status(404).send({
          error: { code: 'MEMBER_NOT_FOUND', message: 'Membership not found' },
        });
      }

      await fastify.prisma.teamMembership.delete({
        where: { id: membership.id },
      });

      return { data: { removed: true } };
    }
  );
};
