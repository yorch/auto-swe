import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../plugins/auth.js';

export const workflowRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/workflows
  fastify.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
    },
    async (request) => {
      const user = request.user!;
      let where: any = {};

      // Non-admins see only workflows for repos belonging to their teams
      if (user.role !== 'ADMIN') {
        where = {
          repository: {
            team: { memberships: { some: { userId: user.sub } } },
          },
        };
      }

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
      const user = request.user!;
      const where: any = { id: request.params.id };

      // Non-admins can only access workflows for repos in their teams
      if (user.role !== 'ADMIN') {
        where.repository = {
          team: { memberships: { some: { userId: user.sub } } },
        };
      }

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
