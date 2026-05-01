import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireAuth } from '../plugins/auth.js';

const CreateRepoSchema = z.object({
  organizationName: z.string().min(1),
  repoName: z.string().min(1),
  teamId: z.string().uuid(),
  defaultBranch: z.string().default('main'),
  language: z.string().optional(),
  description: z.string().optional(),
  githubUrl: z.string().url().optional(),
  githubApiUrl: z.string().url().optional(),
  mcpServerRef: z.string().optional(),
  executorImage: z.string().optional(),
});

const RepoParamsSchema = z.object({ id: z.string().uuid() });

const UpdateRepoSchema = z.object({
  defaultBranch: z.string().optional(),
  language: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  githubUrl: z.string().url().nullable().optional(),
  githubApiUrl: z.string().url().nullable().optional(),
  mcpServerRef: z.string().nullable().optional(),
  executorImage: z.string().nullable().optional(),
  teamId: z.string().uuid().optional(),
  isActive: z.boolean().optional(),
});

export const repositoryRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/repositories — List repositories
  app.get('/', {
    onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
  }, async (request) => {
    const user = request.user!;
    let where: any = { isActive: true };

    // Non-admins see only repos belonging to their teams
    if (user.role !== 'ADMIN') {
      where = {
        ...where,
        team: { memberships: { some: { userId: user.sub } } },
      };
    }

    const repos = await fastify.prisma.repository.findMany({
      where,
      include: {
        team: { select: { id: true, name: true, slug: true } },
        _count: { select: { activeWorkflows: true } },
      },
      orderBy: { repoName: 'asc' },
    });

    return { data: repos };
  });

  // POST /api/v1/repositories — Onboard repository
  app.post('/', {
    schema: { body: CreateRepoSchema },
    onRequest: requireAuth({ requiredRole: 'LEAD' }),
  }, async (request, reply) => {
    const { organizationName, repoName, teamId, ...rest } = request.body;

    // Verify team exists
    const team = await fastify.prisma.team.findUnique({ where: { id: teamId } });
    if (!team || !team.isActive) {
      return reply.status(404).send({
        error: { code: 'TEAM_NOT_FOUND', message: 'Team not found or inactive' },
      });
    }

    // Check for duplicate
    const existing = await fastify.prisma.repository.findUnique({
      where: { organizationName_repoName: { organizationName, repoName } },
    });
    if (existing) {
      return reply.status(409).send({
        error: { code: 'REPO_EXISTS', message: 'Repository already onboarded' },
      });
    }

    const repo = await fastify.prisma.repository.create({
      data: { organizationName, repoName, teamId, ...rest },
      include: { team: { select: { id: true, name: true, slug: true } } },
    });

    return reply.status(201).send({ data: repo });
  });

  // PATCH /api/v1/repositories/:id — Update repository config
  app.patch('/:id', {
    schema: { params: RepoParamsSchema, body: UpdateRepoSchema },
    onRequest: requireAuth({ requiredRole: 'LEAD' }),
  }, async (request, reply) => {
    const repo = await fastify.prisma.repository.findUnique({
      where: { id: request.params.id },
    });
    if (!repo) {
      return reply.status(404).send({
        error: { code: 'REPO_NOT_FOUND', message: 'Repository not found' },
      });
    }

    const updated = await fastify.prisma.repository.update({
      where: { id: request.params.id },
      data: request.body,
      include: { team: { select: { id: true, name: true, slug: true } } },
    });

    return { data: updated };
  });
};
