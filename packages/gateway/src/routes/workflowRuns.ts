import type { Prisma } from '@auto-swe/shared';
import type { EvalResultDto } from '@auto-swe/shared/types/api';
import { WORKFLOW_RUN_STATUSES } from '@auto-swe/shared/types/api';
import { listSteps } from '@auto-swe/shared/workflow';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requireUser } from '../plugins/auth.js';
import { projectRunSummary, RunListPaginationQuery } from './workflowProjections.js';

const RunIdParam = z.object({ id: z.string().uuid() });
const RunDetailQuery = z.object({
  /** Skip server-side trace payload trimming (forensic deep-dive only). */
  fullTraces: z.coerce.boolean().optional().default(false),
  includeTraces: z.coerce.boolean().optional().default(false),
});

/** Max chars per string field in trace payloads returned by the polled run view. */
const TRACE_FIELD_CAP = 4_000;

/**
 * Trim large string fields out of trace payloads. LLM-response rows carry the
 * full system prompt + user message (often tens of KB including diffs) which
 * the run page polls every few seconds but never renders beyond a 2 000-char
 * preview. `?fullTraces=true` bypasses the trim for forensic use.
 */
function trimTraceJson(value: unknown): unknown {
  if (typeof value === 'string' && value.length > TRACE_FIELD_CAP) {
    return `${value.slice(0, TRACE_FIELD_CAP)}…[truncated ${value.length - TRACE_FIELD_CAP} chars — refetch with ?fullTraces=true]`;
  }
  if (Array.isArray(value)) {
    return value.map(trimTraceJson);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, trimTraceJson(v)])
    );
  }
  return value;
}
const ListRunsQuery = RunListPaginationQuery.extend({
  status: z.enum(WORKFLOW_RUN_STATUSES).optional(),
  templateId: z.string().uuid().optional(),
  workRequestId: z.string().uuid().optional(),
});

function runVisibilityFilter(user: { sub: string; role: string }): Prisma.WorkflowRunWhereInput {
  if (user.role === 'ADMIN') {
    return {};
  }
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
            template: { select: { name: true } },
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
      // DB update is the authoritative record; fail the request if it rejects.
      // Temporal cancel is best-effort: the workflow's CancelledFailure handler
      // will also write CANCELLED, so a transient Temporal blip isn't fatal.
      await fastify.prisma.workflowRun.update({
        data: { endedAt: new Date(), status: 'CANCELLED' },
        where: { id: run.id },
      });
      fastify.temporal.cancelWorkflow(run.workflowId).catch((err: unknown) => {
        request.log.error({ err, workflowId: run.workflowId }, 'Temporal cancel signal failed');
      });
      return { data: { id: run.id, status: 'CANCELLED' } };
    }
  );

  // ── Get captured eval signals for a run (P0 evals) ──
  app.get(
    '/:id/eval-results',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: RunIdParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const run = await fastify.prisma.workflowRun.findFirst({
        select: { id: true },
        where: { id: request.params.id, ...runVisibilityFilter(user) },
      });
      if (!run) {
        return reply.status(404).send({
          error: { code: 'RUN_NOT_FOUND', message: 'Workflow run not found' },
        });
      }
      const rows = await fastify.prisma.evalResult.findMany({
        orderBy: { createdAt: 'asc' },
        where: { runId: run.id },
      });
      const data: EvalResultDto[] = rows.map((r) => ({
        agentKey: r.agentKey,
        createdAt: r.createdAt.toISOString(),
        id: r.id,
        metadata: r.metadata,
        nodeId: r.nodeId,
        passed: r.passed,
        rationale: r.rationale,
        runId: r.runId,
        scorer: r.scorer,
        scoreType: r.scoreType,
        source: r.source,
        value: r.value,
      }));
      return { data };
    }
  );

  // ── Get run detail (with steps + spec snapshot) ──
  app.get(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: RunIdParam, querystring: RunDetailQuery },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { fullTraces, includeTraces } = request.query;
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
      const traces = includeTraces
        ? await fastify.prisma.agentTrace.findMany({
            orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }],
            where: { runId: run.id },
          })
        : [];
      return {
        data: {
          contextSnapshot: run.contextSnapshot,
          costUsdAccrued: run.costUsdAccrued,
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
          tokensInputTotal: run.tokensInputTotal,
          tokensOutputTotal: run.tokensOutputTotal,
          traces: traces.map((t) => ({
            agentKey: t.agentKey,
            attempt: t.attempt,
            costUsd: t.costUsd,
            createdAt: t.createdAt,
            durationMs: t.durationMs,
            error: t.error,
            id: t.id,
            inputJson: fullTraces ? t.inputJson : trimTraceJson(t.inputJson),
            inputTokens: t.inputTokens,
            model: t.model,
            nodeId: t.nodeId,
            otelSpanId: t.otelSpanId,
            otelTraceId: t.otelTraceId,
            outputJson: fullTraces ? t.outputJson : trimTraceJson(t.outputJson),
            outputTokens: t.outputTokens,
            seq: t.seq,
            toolName: t.toolName,
            type: t.type,
          })),
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
