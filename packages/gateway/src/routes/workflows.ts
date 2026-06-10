import type { Prisma } from '@auto-swe/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requireUser } from '../plugins/auth.js';

// Default high enough that the dashboard's KPI view covers recent history,
// but bounded — the table only grows and this endpoint is polled every 10s.
const ListWorkflowsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export const workflowRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/workflows
  app.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: ListWorkflowsQuery },
    },
    async (request) => {
      const user = requireUser(request);
      const { limit, offset } = request.query;
      const where: Prisma.ActiveWorkflowWhereInput =
        user.role === 'ADMIN'
          ? {}
          : {
              repository: {
                team: { memberships: { some: { userId: user.sub } } },
              },
            };

      const [workflows, total] = await Promise.all([
        fastify.prisma.activeWorkflow.findMany({
          include: { pullRequests: true, repository: true },
          orderBy: { updatedAt: 'desc' },
          skip: offset,
          take: limit,
          where,
        }),
        fastify.prisma.activeWorkflow.count({ where }),
      ]);
      return { data: workflows, meta: { limit, offset, total } };
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
