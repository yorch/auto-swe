import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireAuth } from '../plugins/auth.js';

export const lessonRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/lessons — List lessons
  app.get('/', {
    onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
  }, async (request) => {
    const user = request.user!;
    let where: any = {};

    // Non-admins only see lessons from their team's repos
    if (user.role !== 'ADMIN') {
      where = {
        repository: {
          team: { memberships: { some: { userId: user.sub } } },
        },
      };
    }

    const lessons = await fastify.prisma.agentLesson.findMany({
      where,
      select: {
        id: true,
        rationale: true,
        lessonSummary: true,
        failureType: true,
        metadata: true,
        createdAt: true,
        repository: { select: { id: true, organizationName: true, repoName: true } },
        workflow: { select: { id: true, temporalWorkflowId: true, currentStatus: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return { data: lessons };
  });

  // GET /api/v1/lessons/search — Semantic similarity search
  app.get('/search', {
    onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
  }, async (request, reply) => {
    const { q, repoId, limit } = request.query as { q?: string; repoId?: string; limit?: string };

    if (!q || !repoId) {
      return reply.status(400).send({
        error: { code: 'MISSING_PARAMS', message: 'q and repoId query parameters are required' },
      });
    }

    // Semantic search requires the worker's embedding + pgvector query
    // For the gateway API, we do a text-based fallback search
    const lessons = await fastify.prisma.agentLesson.findMany({
      where: {
        repoId,
        OR: [
          { lessonSummary: { contains: q, mode: 'insensitive' } },
          { rationale: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        rationale: true,
        lessonSummary: true,
        failureType: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit ?? '10'),
    });

    return { data: lessons };
  });

  // DELETE /api/v1/lessons/:id — Delete lesson (ADMIN only)
  app.delete<{ Params: { id: string } }>('/:id', {
    onRequest: requireAuth({ requiredRole: 'ADMIN' }),
  }, async (request, reply) => {
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
  });
};
