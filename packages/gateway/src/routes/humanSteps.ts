import { Prisma } from '@auto-swe/shared';
import { HITL_VALID_ACTIONS, type HitlKind } from '@auto-swe/shared/workflow/interpreter';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requireUser } from '../plugins/auth.js';

const StepIdParam = z.object({ id: z.string().uuid() });

const RespondBody = z.object({
  action: z.string().min(1).max(50),
  value: z.unknown().optional(),
});

function runVisibilityFilter(user: {
  sub: string;
  role: string;
}): Prisma.WorkflowHumanStepWhereInput {
  if (user.role === 'ADMIN') {
    return {};
  }
  return {
    run: {
      OR: [
        { template: { teamId: null } },
        { template: { team: { memberships: { some: { userId: user.sub } } } } },
        {
          workRequest: {
            activeWorkflows: {
              some: { repository: { team: { memberships: { some: { userId: user.sub } } } } },
            },
          },
        },
      ],
    },
  };
}

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

  // Respond to a pending step
  app.post(
    '/:id/respond',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { body: RespondBody, params: StepIdParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const step = await fastify.prisma.workflowHumanStep.findFirst({
        include: { run: { select: { status: true, workflowId: true } } },
        where: { id: request.params.id, ...runVisibilityFilter(user) },
      });
      if (!step) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Human step not found' } });
      }
      if (step.status !== 'PENDING') {
        return reply.status(409).send({
          error: { code: 'ALREADY_RESOLVED', message: 'This step has already been resolved' },
        });
      }
      if (step.run.status !== 'RUNNING') {
        return reply.status(409).send({
          error: { code: 'RUN_NOT_RUNNING', message: 'The workflow run is no longer running' },
        });
      }

      const { action, value } = request.body;

      // Validate action against step kind using the shared HITL_VALID_ACTIONS map.
      // The map is Record<HitlKind, …> so TypeScript enforces exhaustiveness whenever
      // a new kind is added to the interpreter — this file stays in sync automatically.
      const allowed = HITL_VALID_ACTIONS[step.kind as HitlKind];
      if (!allowed) {
        return reply.status(400).send({
          error: {
            code: 'UNKNOWN_KIND',
            message: `Unknown step kind: ${step.kind}`,
          },
        });
      }
      if (!allowed.includes(action)) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_ACTION',
            message: `Action '${action}' is not valid for ${step.kind} steps. Expected: ${allowed.join(' or ')}`,
          },
        });
      }

      const signalPayload = { action, resolvedBy: user.sub, value };

      // Atomic update — guards against concurrent resolve (race condition).
      // The prior status check is an optimistic fast-path; this is the real guard.
      const result = await fastify.prisma.workflowHumanStep.updateMany({
        data: {
          payload: signalPayload as Prisma.InputJsonValue,
          resolvedAt: new Date(),
          resolvedBy: user.sub,
          status: 'RESOLVED',
        },
        where: { id: step.id, status: 'PENDING' },
      });
      if (result.count === 0) {
        return reply.status(409).send({
          error: { code: 'ALREADY_RESOLVED', message: 'This step has already been resolved' },
        });
      }

      // Deliver the Temporal signal. The workflow only unblocks via this
      // signal — if it fails after the row was marked RESOLVED, the step
      // would vanish from the inbox while the workflow stays stuck until its
      // timeout. Roll the row back to PENDING on failure so the user can
      // retry instead of stranding the run.
      try {
        await fastify.temporal.signalWorkflow(step.run.workflowId, step.signalName, [
          signalPayload,
        ]);
      } catch (err: unknown) {
        request.log.error({ err, stepId: step.id }, 'HITL Temporal signal failed; rolling back');
        await fastify.prisma.workflowHumanStep
          .updateMany({
            data: {
              payload: Prisma.DbNull,
              resolvedAt: null,
              resolvedBy: null,
              status: 'PENDING',
            },
            where: { id: step.id, resolvedBy: user.sub, status: 'RESOLVED' },
          })
          .catch((rollbackErr: unknown) => {
            request.log.error(
              { err: rollbackErr, stepId: step.id },
              'HITL rollback failed — step stuck RESOLVED without a delivered signal'
            );
          });
        return reply.status(502).send({
          error: {
            code: 'SIGNAL_FAILED',
            message: 'Could not deliver the response to the workflow — please retry',
          },
        });
      }

      return { data: { id: step.id, status: 'RESOLVED' } };
    }
  );
};
