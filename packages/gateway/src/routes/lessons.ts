import type { Prisma } from '@auto-swe/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireAuth, requireUser } from '../plugins/auth.js';

export const lessonRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/lessons — List lessons
  app.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
    },
    async (request) => {
      const user = requireUser(request);
      const where: Prisma.AgentLessonWhereInput =
        user.role === 'ADMIN'
          ? {}
          : {
              repository: {
                team: { memberships: { some: { userId: user.sub } } },
              },
            };

      const lessons = await fastify.prisma.agentLesson.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
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
    },
    async (request, reply) => {
      const { q, repoId, limit } = request.query as { q?: string; repoId?: string; limit?: string };

      if (!q || !repoId) {
        return reply.status(400).send({
          error: { code: 'MISSING_PARAMS', message: 'q and repoId query parameters are required' },
        });
      }

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
        take: Math.min(Math.max(parseInt(limit ?? '10', 10) || 10, 1), 100),
        where: {
          OR: [
            { lessonSummary: { contains: q, mode: 'insensitive' } },
            { rationale: { contains: q, mode: 'insensitive' } },
          ],
          repoId,
        },
      });

      return { data: lessons };
    }
  );

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
