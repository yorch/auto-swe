import type { Prisma } from '@auto-swe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { requireAuth, requireUser } from '../plugins/auth.js';

export const workflowRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/workflows
  fastify.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
    },
    async (request) => {
      const user = requireUser(request);
      const where: Prisma.ActiveWorkflowWhereInput =
        user.role === 'ADMIN'
          ? {}
          : {
              repository: {
                team: { memberships: { some: { userId: user.sub } } },
              },
            };

      const workflows = await fastify.prisma.activeWorkflow.findMany({
        include: { pullRequests: true, repository: true },
        orderBy: { updatedAt: 'desc' },
        where,
      });
      return { data: workflows };
    }
  );

  // GET /api/v1/workflows/:id
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
    },
    async (request, reply) => {
      const user = requireUser(request);
      const where: Prisma.ActiveWorkflowWhereInput = {
        id: request.params.id,
        ...(user.role !== 'ADMIN' && {
          repository: { team: { memberships: { some: { userId: user.sub } } } },
        }),
      };

      const workflow = await fastify.prisma.activeWorkflow.findFirst({
        include: { pullRequests: true, repository: true, workRequest: true },
        where,
      });
      if (!workflow) {
        return reply.status(404).send({
          error: {
            code: 'WORKFLOW_NOT_FOUND',
            message: `No workflow with id ${request.params.id}`,
          },
        });
      }
      return { data: workflow };
    }
  );
};
