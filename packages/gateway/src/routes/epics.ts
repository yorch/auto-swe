import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';

const CreateEpicSchema = z.object({
  description: z
    .string()
    .min(1, 'description is required — tell the agent what to build across repos'),
  externalTicketId: z.string().min(1),
  repoIds: z.array(z.string().uuid()).min(1),
});

export const epicRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: {
        body: CreateEpicSchema,
      },
    },
    async (request, reply) => {
      const { externalTicketId, description, repoIds } = request.body;

      // Validate all repos exist and are active
      const repos = await fastify.prisma.repository.findMany({
        select: { id: true },
        where: { id: { in: repoIds }, isActive: true },
      });

      const foundIds = new Set(repos.map((r: { id: string }) => r.id));
      const missingIds = repoIds.filter((id) => !foundIds.has(id));
      if (missingIds.length > 0) {
        return reply.status(404).send({
          error: {
            code: 'REPOS_NOT_FOUND',
            message: `Repositories not found or inactive: ${missingIds.join(', ')}`,
          },
        });
      }

      const workRequestId = crypto.randomUUID();
      const epicWorkflowId = `epic-${externalTicketId}`;

      // Start Temporal epic workflow FIRST (idempotency gate)
      try {
        await fastify.temporal.startEpicWorkflow(epicWorkflowId, {
          description,
          epicWorkflowId,
          externalTicketId,
          repoIds,
          repos: [], // Empty — Planner Agent will decompose
          requestPayload: JSON.stringify(request.body),
          workRequestId,
        });
      } catch (err: any) {
        if (err.name === 'WorkflowExecutionAlreadyStartedError') {
          return reply.status(409).send({
            error: {
              code: 'EPIC_ALREADY_EXISTS',
              message: `Epic workflow already running for ${externalTicketId}`,
            },
          });
        }
        throw err;
      }

      // Persist work request to DB
      await fastify.prisma.workRequest.create({
        data: {
          description,
          externalTicketId,
          id: workRequestId,
          isCrossRepo: true,
          requestPayload: JSON.stringify(request.body),
        },
      });

      return reply.status(201).send({
        data: {
          epicWorkflowId,
          workRequestId,
        },
      });
    }
  );
};
