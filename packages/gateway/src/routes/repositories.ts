import type { Prisma } from '@auto-swe/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requireUser } from '../plugins/auth.js';

const CreateRepoSchema = z.object({
  defaultBranch: z.string().default('main'),
  description: z.string().optional(),
  executorImage: z.string().optional(),
  githubApiUrl: z.string().url().optional(),
  githubUrl: z.string().url().optional(),
  language: z.string().optional(),
  mcpServerRef: z.string().optional(),
  organizationName: z.string().min(1),
  repoName: z.string().min(1),
  teamId: z.string().uuid(),
});

const RepoParamsSchema = z.object({ id: z.string().uuid() });

const UpdateRepoSchema = z.object({
  defaultBranch: z.string().optional(),
  description: z.string().nullable().optional(),
  executorImage: z.string().nullable().optional(),
  githubApiUrl: z.string().url().nullable().optional(),
  githubUrl: z.string().url().nullable().optional(),
  isActive: z.boolean().optional(),
  language: z.string().nullable().optional(),
  mcpServerRef: z.string().nullable().optional(),
  teamId: z.string().uuid().optional(),
});

export const repositoryRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/repositories — List repositories
  app.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
    },
    async (request) => {
      const user = requireUser(request);
      const where: Prisma.RepositoryWhereInput = {
        isActive: true,
        ...(user.role !== 'ADMIN' && {
          team: { memberships: { some: { userId: user.sub } } },
        }),
      };

      const repos = await fastify.prisma.repository.findMany({
        include: {
          _count: { select: { activeWorkflows: true } },
          team: { select: { id: true, name: true, slug: true } },
        },
        orderBy: { repoName: 'asc' },
        where,
      });

      return { data: repos };
    }
  );

  // POST /api/v1/repositories — Onboard repository
  app.post(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { body: CreateRepoSchema },
    },
    async (request, reply) => {
      const { organizationName, repoName, teamId, ...rest } = request.body;

      // Verify team exists
      const team = await fastify.prisma.team.findUnique({ where: { id: teamId } });
      if (!team?.isActive) {
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
    }
  );

  // PATCH /api/v1/repositories/:id — Update repository config
  app.patch(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { body: UpdateRepoSchema, params: RepoParamsSchema },
    },
    async (request, reply) => {
      const repo = await fastify.prisma.repository.findUnique({
        where: { id: request.params.id },
      });
      if (!repo) {
        return reply.status(404).send({
          error: { code: 'REPO_NOT_FOUND', message: 'Repository not found' },
        });
      }

      const updated = await fastify.prisma.repository.update({
        data: request.body,
        include: { team: { select: { id: true, name: true, slug: true } } },
        where: { id: request.params.id },
      });

      return { data: updated };
    }
  );
};
