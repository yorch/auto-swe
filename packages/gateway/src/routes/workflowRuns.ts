import type { Prisma } from '@auto-swe/shared';
import { WORKFLOW_RUN_STATUSES } from '@auto-swe/shared/types/api';
import { listSteps } from '@auto-swe/shared/workflow';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requireUser } from '../plugins/auth.js';
import { projectRunSummary, RunListPaginationQuery } from './workflowProjections.js';

const RunIdParam = z.object({ id: z.string().uuid() });
const ListRunsQuery = RunListPaginationQuery.extend({
  status: z.enum(WORKFLOW_RUN_STATUSES).optional(),
  templateId: z.string().uuid().optional(),
  workRequestId: z.string().uuid().optional(),
});

function runVisibilityFilter(user: { sub: string; role: string }): Prisma.WorkflowRunWhereInput {
  if (user.role === 'ADMIN') return {};
  // A run is visible if either the template is global / on the user's team, or
  // the originating work request targets a repo on the user's team.
  return {
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
  };
}

export const workflowRunRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // ── List runs ──
  app.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: ListRunsQuery },
    },
    async (request) => {
      const user = requireUser(request);
      const { limit, offset, status, templateId, workRequestId } = request.query;
      const where: Prisma.WorkflowRunWhereInput = {
        ...runVisibilityFilter(user),
        ...(status ? { status } : {}),
        ...(templateId ? { templateId } : {}),
        ...(workRequestId ? { workRequestId } : {}),
      };
      const [rows, total] = await Promise.all([
        fastify.prisma.workflowRun.findMany({
          include: {
            workRequest: {
              select: { description: true, externalTicketId: true, id: true },
            },
          },
          orderBy: { startedAt: 'desc' },
          skip: offset,
          take: limit,
          where,
        }),
        fastify.prisma.workflowRun.count({ where }),
      ]);
      return {
        data: rows.map(projectRunSummary),
        meta: { limit, offset, total },
      };
    }
  );

  // ── Cancel a running workflow ──
  app.post(
    '/:id/cancel',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: RunIdParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const run = await fastify.prisma.workflowRun.findFirst({
        where: { id: request.params.id, ...runVisibilityFilter(user) },
      });
      if (!run) {
        return reply
          .status(404)
          .send({ error: { code: 'RUN_NOT_FOUND', message: 'Workflow run not found' } });
      }
      if (run.status !== 'RUNNING') {
        return reply.status(409).send({
          error: { code: 'RUN_NOT_RUNNING', message: 'Only RUNNING runs can be cancelled' },
        });
      }
      // Request Temporal cancellation; the workflow surfaces CancelledFailure,
      // which RunnableWorkflow catches to mark the run CANCELLED in the DB.
      // We also write CANCELLED here optimistically so the UI updates instantly
      // even if the worker is briefly unreachable.
      await Promise.allSettled([
        fastify.temporal.cancelWorkflow(run.workflowId),
        fastify.prisma.workflowRun.update({
          data: { endedAt: new Date(), status: 'CANCELLED' },
          where: { id: run.id },
        }),
      ]);
      return { data: { id: run.id, status: 'CANCELLED' } };
    }
  );

  // ── Get run detail (with steps + spec snapshot) ──
  app.get(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: RunIdParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const run = await fastify.prisma.workflowRun.findFirst({
        include: {
          steps: { orderBy: [{ startedAt: 'asc' }, { attempt: 'asc' }] },
          template: { select: { name: true } },
          workRequest: {
            select: { description: true, externalTicketId: true, id: true },
          },
        },
        where: { id: request.params.id, ...runVisibilityFilter(user) },
      });
      if (!run) {
        return reply.status(404).send({
          error: { code: 'RUN_NOT_FOUND', message: 'Workflow run not found' },
        });
      }
      return {
        data: {
          contextSnapshot: run.contextSnapshot,
          endedAt: run.endedAt,
          id: run.id,
          specSnapshot: run.specSnapshot,
          startedAt: run.startedAt,
          status: run.status,
          steps: run.steps.map((s) => ({
            attempt: s.attempt,
            endedAt: s.endedAt,
            error: s.error,
            id: s.id,
            inputs: s.inputs,
            nodeId: s.nodeId,
            outputs: s.outputs,
            startedAt: s.startedAt,
            status: s.status,
          })),
          templateId: run.templateId,
          templateName: run.template.name,
          templateVersion: run.templateVersion,
          workflowId: run.workflowId,
          workRequest: run.workRequest,
        },
      };
    }
  );
};

export const stepRegistryRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Step palette catalog (for the web editor) ──
  fastify.get('/registry', { onRequest: requireAuth({ requiredRole: 'ENGINEER' }) }, async () => ({
    data: listSteps(),
  }));
};
