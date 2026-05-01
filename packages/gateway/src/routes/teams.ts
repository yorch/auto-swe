import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireAuth } from '../plugins/auth.js';

const CreateTeamSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'slug must be lowercase-kebab-case'),
  description: z.string().max(500).default(''),
});

const UpdateTeamSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
});

const TeamParamsSchema = z.object({ id: z.string().uuid() });
const TeamMemberParamsSchema = z.object({ id: z.string().uuid(), userId: z.string().uuid() });

const AddMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['ADMIN', 'LEAD', 'ENGINEER']).default('ENGINEER'),
});

const UpdateMemberSchema = z.object({
  role: z.enum(['ADMIN', 'LEAD', 'ENGINEER']),
});

export const teamRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // POST /api/v1/teams — Create team (ADMIN only)
  app.post('/', {
    schema: { body: CreateTeamSchema },
    onRequest: requireAuth({ requiredRole: 'ADMIN' }),
  }, async (request, reply) => {
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
      data: { name, slug, description },
    });

    return reply.status(201).send({ data: team });
  });

  // GET /api/v1/teams — List teams
  app.get('/', {
    onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
  }, async (request) => {
    const user = request.user!;
    let where: any = { isActive: true };

    // Non-admins see only their teams
    if (user.role !== 'ADMIN') {
      where = {
        ...where,
        memberships: { some: { userId: user.sub } },
      };
    }

    const teams = await fastify.prisma.team.findMany({
      where,
      include: {
        _count: { select: { memberships: true, repositories: true } },
      },
      orderBy: { name: 'asc' },
    });

    return { data: teams };
  });

  // GET /api/v1/teams/:id — Team detail
  app.get<{ Params: { id: string } }>('/:id', {
    onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
  }, async (request, reply) => {
    const user = request.user!;

    const team = await fastify.prisma.team.findUnique({
      where: { id: request.params.id },
      include: {
        memberships: { include: { user: { select: { id: true, email: true, role: true } } } },
        repositories: { select: { id: true, organizationName: true, repoName: true, isActive: true } },
      },
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
  });

  // PATCH /api/v1/teams/:id — Update team (requires LEAD in this team)
  app.patch('/:id', {
    schema: { params: TeamParamsSchema, body: UpdateTeamSchema },
    onRequest: requireAuth({ requiredRole: 'LEAD', requiredTeamRole: 'LEAD', teamIdParam: 'id' }),
  }, async (request, reply) => {
    const team = await fastify.prisma.team.findUnique({
      where: { id: request.params.id },
    });
    if (!team) {
      return reply.status(404).send({
        error: { code: 'TEAM_NOT_FOUND', message: 'Team not found' },
      });
    }

    const updated = await fastify.prisma.team.update({
      where: { id: request.params.id },
      data: request.body,
    });

    return { data: updated };
  });

  // DELETE /api/v1/teams/:id — Soft-delete team (ADMIN only)
  app.delete<{ Params: { id: string } }>('/:id', {
    onRequest: requireAuth({ requiredRole: 'ADMIN' }),
  }, async (request, reply) => {
    const team = await fastify.prisma.team.findUnique({
      where: { id: request.params.id },
    });
    if (!team) {
      return reply.status(404).send({
        error: { code: 'TEAM_NOT_FOUND', message: 'Team not found' },
      });
    }

    await fastify.prisma.team.update({
      where: { id: request.params.id },
      data: { isActive: false },
    });

    return { data: { deleted: true } };
  });

  // ── Team Members ──

  // GET /api/v1/teams/:id/members
  app.get<{ Params: { id: string } }>('/:id/members', {
    onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
  }, async (request, reply) => {
    const team = await fastify.prisma.team.findUnique({
      where: { id: request.params.id },
    });
    if (!team) {
      return reply.status(404).send({
        error: { code: 'TEAM_NOT_FOUND', message: 'Team not found' },
      });
    }

    const members = await fastify.prisma.teamMembership.findMany({
      where: { teamId: request.params.id },
      include: { user: { select: { id: true, email: true, role: true, slackId: true, isActive: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return { data: members };
  });

  // POST /api/v1/teams/:id/members — Add member (requires LEAD in this team)
  app.post('/:id/members', {
    schema: { params: TeamParamsSchema, body: AddMemberSchema },
    onRequest: requireAuth({ requiredRole: 'LEAD', requiredTeamRole: 'LEAD', teamIdParam: 'id' }),
  }, async (request, reply) => {
    const { userId, role } = request.body;

    const existing = await fastify.prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId, teamId: request.params.id } },
    });
    if (existing) {
      return reply.status(409).send({
        error: { code: 'MEMBER_EXISTS', message: 'User is already a member of this team' },
      });
    }

    const membership = await fastify.prisma.teamMembership.create({
      data: {
        userId,
        teamId: request.params.id,
        role,
      },
      include: { user: { select: { id: true, email: true, role: true } } },
    });

    return reply.status(201).send({ data: membership });
  });

  // PATCH /api/v1/teams/:id/members/:userId — Update member role (requires LEAD in this team)
  app.patch('/:id/members/:userId', {
    schema: { params: TeamMemberParamsSchema, body: UpdateMemberSchema },
    onRequest: requireAuth({ requiredRole: 'LEAD', requiredTeamRole: 'LEAD', teamIdParam: 'id' }),
  }, async (request, reply) => {
    const membership = await fastify.prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId: request.params.userId, teamId: request.params.id } },
    });
    if (!membership) {
      return reply.status(404).send({
        error: { code: 'MEMBER_NOT_FOUND', message: 'Membership not found' },
      });
    }

    const updated = await fastify.prisma.teamMembership.update({
      where: { id: membership.id },
      data: { role: request.body.role },
    });

    return { data: updated };
  });

  // DELETE /api/v1/teams/:id/members/:userId — Remove member (requires LEAD in this team)
  app.delete<{ Params: { id: string; userId: string } }>('/:id/members/:userId', {
    onRequest: requireAuth({ requiredRole: 'LEAD', requiredTeamRole: 'LEAD', teamIdParam: 'id' }),
  }, async (request, reply) => {
    const membership = await fastify.prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId: request.params.userId, teamId: request.params.id } },
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
  });
};
