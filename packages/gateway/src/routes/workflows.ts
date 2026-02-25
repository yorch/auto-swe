import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../plugins/auth.js';

export const workflowRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/workflows
  fastify.get('/', {
    onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
  }, async () => {
    const workflows = await fastify.prisma.activeWorkflow.findMany({
      include: { repository: true, pullRequests: true },
      orderBy: { updatedAt: 'desc' },
    });
    return { data: workflows };
  });

  // GET /api/v1/workflows/:id
  fastify.get<{ Params: { id: string } }>('/:id', {
    onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
  }, async (request, reply) => {
    const workflow = await fastify.prisma.activeWorkflow.findUnique({
      where: { id: request.params.id },
      include: { repository: true, pullRequests: true, workRequest: true },
    });
    if (!workflow) {
      return reply.status(404).send({
        error: { code: 'WORKFLOW_NOT_FOUND', message: `No workflow with id ${request.params.id}` },
      });
    }
    return { data: workflow };
  });
};
