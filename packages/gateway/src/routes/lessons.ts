import type { Prisma } from '@auto-swe/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requireUser } from '../plugins/auth.js';

const ConsolidateBody = z.object({
  minClusterSize: z.number().int().min(2).max(20).optional(),
  repoId: z.string().uuid(),
  similarityThreshold: z.number().min(0.5).max(1).optional(),
});

const LessonListQuery = z.object({
  includeConsolidated: z.coerce.boolean().default(false),
});

const LessonSearchQuery = z.object({
  includeConsolidated: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  q: z.string().min(1),
  repoId: z.string().uuid(),
});

export const lessonRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/lessons — List lessons
  app.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: LessonListQuery },
    },
    async (request) => {
      const user = requireUser(request);
      const { includeConsolidated } = request.query;

      const accessFilter: Prisma.AgentLessonWhereInput =
        user.role === 'ADMIN'
          ? {}
          : { repository: { team: { memberships: { some: { userId: user.sub } } } } };

      const where: Prisma.AgentLessonWhereInput = {
        ...accessFilter,
        ...(!includeConsolidated && { consolidatedAt: null }),
      };

      const lessons = await fastify.prisma.agentLesson.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          consolidatedAt: true,
          createdAt: true,
          failureType: true,
          id: true,
          lessonSummary: true,
          metadata: true,
          rationale: true,
          repository: { select: { id: true, organizationName: true, repoName: true } },
          workflow: { select: { currentStatus: true, id: true, temporalWorkflowId: true } },
        },
        take: 100,
        where,
      });

      return { data: lessons };
    }
  );

  // GET /api/v1/lessons/search — Semantic similarity search
  app.get(
    '/search',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: LessonSearchQuery },
    },
    async (request, reply) => {
      const { q, repoId, limit, includeConsolidated } = request.query;

      // Non-admins must be a member of the team that owns the repo they're searching
      const user = requireUser(request);
      if (user.role !== 'ADMIN') {
        const accessibleRepo = await fastify.prisma.repository.findFirst({
          select: { id: true },
          where: {
            id: repoId,
            team: { memberships: { some: { userId: user.sub } } },
          },
        });
        if (!accessibleRepo) {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'You do not have access to this repository' },
          });
        }
      }

      // Semantic search requires the worker's embedding + pgvector query
      // For the gateway API, we do a text-based fallback search
      const lessons = await fastify.prisma.agentLesson.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          createdAt: true,
          failureType: true,
          id: true,
          lessonSummary: true,
          rationale: true,
        },
        take: limit,
        where: {
          OR: [
            { lessonSummary: { contains: q, mode: 'insensitive' } },
            { rationale: { contains: q, mode: 'insensitive' } },
          ],
          ...(!includeConsolidated && { consolidatedAt: null }),
          repoId,
        },
      });

      return { data: lessons };
    }
  );

  // POST /api/v1/lessons/consolidate — Trigger lesson consolidation (ADMIN only)
  app.post(
    '/consolidate',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { body: ConsolidateBody },
    },
    async (request, reply) => {
      const { repoId, minClusterSize, similarityThreshold } = request.body;

      const repo = await fastify.prisma.repository.findUnique({
        select: { id: true },
        where: { id: repoId },
      });
      if (!repo) {
        return reply.status(404).send({
          error: { code: 'REPO_NOT_FOUND', message: 'Repository not found' },
        });
      }

      const workflowId = `consolidate-lessons-${repoId}-${Date.now()}`;
      await fastify.temporal.startConsolidationWorkflow(workflowId, {
        minClusterSize,
        repoId,
        similarityThreshold,
      });

      return reply.status(202).send({ data: { workflowId } });
    }
  );

  // GET /api/v1/lessons/stats — Per-repo aggregate stats (ADMIN only)
  app.get('/stats', { onRequest: requireAuth({ requiredRole: 'ADMIN' }) }, async () => {
    const repos = await fastify.prisma.repository.findMany({
      orderBy: [{ organizationName: 'asc' }, { repoName: 'asc' }],
      select: {
        agentLessons: {
          orderBy: { consolidatedAt: 'desc' },
          select: { consolidatedAt: true },
        },
        id: true,
        organizationName: true,
        repoName: true,
      },
    });

    const data = repos.map((repo) => {
      const activeCount = repo.agentLessons.filter((l) => l.consolidatedAt === null).length;
      const consolidatedCount = repo.agentLessons.filter((l) => l.consolidatedAt !== null).length;
      const lastConsolidated = repo.agentLessons.find((l) => l.consolidatedAt !== null);
      return {
        activeCount,
        consolidatedCount,
        id: repo.id,
        lastConsolidatedAt: lastConsolidated?.consolidatedAt ?? null,
        organizationName: repo.organizationName,
        repoName: repo.repoName,
        totalCount: repo.agentLessons.length,
      };
    });

    return { data };
  });

  // DELETE /api/v1/lessons/:id — Delete lesson (ADMIN only)
  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
    },
    async (request, reply) => {
      const lesson = await fastify.prisma.agentLesson.findUnique({
        where: { id: request.params.id },
      });
      if (!lesson) {
        return reply.status(404).send({
          error: { code: 'LESSON_NOT_FOUND', message: 'Lesson not found' },
        });
      }

      await fastify.prisma.agentLesson.delete({
        where: { id: request.params.id },
      });

      return { data: { deleted: true } };
    }
  );
};
