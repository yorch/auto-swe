import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  type HitlResolveErrorCode,
  resolveHitlStep,
  runVisibilityFilter,
} from '../lib/hitlResolve.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const StepIdParam = z.object({ id: z.string().uuid() });

const RespondBody = z.object({
  action: z.string().min(1).max(50),
  value: z.unknown().optional(),
});

/**
 * HTTP status per resolve-core error code. The resolve logic itself lives in
 * `lib/hitlResolve.ts` so the Slack interactivity handler can share it — this
 * map preserves the inbox route's original wire contract exactly.
 */
const STATUS_BY_CODE: Record<HitlResolveErrorCode, number> = {
  ALREADY_RESOLVED: 409,
  INVALID_ACTION: 400,
  NOT_FOUND: 404,
  RUN_NOT_RUNNING: 409,
  SIGNAL_FAILED: 502,
  UNKNOWN_KIND: 400,
};

export const humanStepRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // List pending human steps for current user
  app.get('/', { onRequest: requireAuth({ requiredRole: 'ENGINEER' }) }, async (request) => {
    const user = requireUser(request);
    const steps = await fastify.prisma.workflowHumanStep.findMany({
      include: {
        run: {
          select: {
            id: true,
            status: true,
            workflowId: true,
            workRequest: { select: { description: true, externalTicketId: true } },
          },
        },
      },
      orderBy: { requestedAt: 'desc' },
      take: 100,
      where: {
        status: 'PENDING',
        ...runVisibilityFilter(user),
      },
    });
    return {
      data: steps.map((s) => ({
        context: s.context,
        description: s.description,
        fields: s.fields,
        id: s.id,
        kind: s.kind,
        nodeId: s.nodeId,
        options: s.options,
        requestedAt: s.requestedAt,
        run: s.run,
        runId: s.runId,
        status: s.status,
        title: s.title,
      })),
    };
  });

  // Get one step
  app.get(
    '/:id',
    { onRequest: requireAuth({ requiredRole: 'ENGINEER' }), schema: { params: StepIdParam } },
    async (request, reply) => {
      const user = requireUser(request);
      const step = await fastify.prisma.workflowHumanStep.findFirst({
        include: {
          run: {
            select: {
              id: true,
              status: true,
              workflowId: true,
              workRequest: { select: { description: true, externalTicketId: true } },
            },
          },
        },
        where: { id: request.params.id, ...runVisibilityFilter(user) },
      });
      if (!step) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Human step not found' } });
      }
      return { data: step };
    }
  );

  // Respond to a pending step. The validation / atomic-resolve / signal-with-
  // rollback core is shared with the Slack `hitl_resolve` button handler via
  // lib/hitlResolve.ts.
  app.post(
    '/:id/respond',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { body: RespondBody, params: StepIdParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { action, value } = request.body;

      const result = await resolveHitlStep(
        { log: request.log, prisma: fastify.prisma, temporal: fastify.temporal },
        request.params.id,
        action,
        value,
        user
      );

      if (!result.ok) {
        return reply
          .status(STATUS_BY_CODE[result.code])
          .send({ error: { code: result.code, message: result.message } });
      }

      return { data: { id: result.stepId, status: 'RESOLVED' } };
    }
  );
};
