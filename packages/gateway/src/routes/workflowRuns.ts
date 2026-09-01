import type { Prisma } from '@auto-swe/shared';
import {
  CHANNEL_ASSISTANT_TEMPLATE_NAME,
  CHANNEL_TASK_TEMPLATE_NAME,
} from '@auto-swe/shared/lib/channelTask';
import type { EvalResultDto } from '@auto-swe/shared/types/api';
import { WORKFLOW_RUN_STATUSES } from '@auto-swe/shared/types/api';
import { listSteps } from '@auto-swe/shared/workflow';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { booleanQueryParam } from '../lib/queryParams.js';
import { buildWorkflowRunVisibilityFilter } from '../lib/runVisibility.js';
import { requireAuth, requireUser } from '../plugins/auth.js';
import {
  projectAutonomyDecision,
  projectEvalResult,
  projectRunSummary,
  RunListPaginationQuery,
} from './workflowProjections.js';

const RunIdParam = z.object({ id: z.string().uuid() });
const RunDetailQuery = z.object({
  /** Skip server-side trace payload trimming (forensic deep-dive only). */
  fullTraces: booleanQueryParam(false),
  includeTraces: booleanQueryParam(false),
});

const ErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const RunListResponseSchema = z.object({
  data: z.array(z.unknown()),
  meta: z.object({ limit: z.number(), offset: z.number(), total: z.number() }),
});

const RunDetailResponseSchema = z.object({ data: z.unknown() });

const CancelRunResponseSchema = z.object({
  data: z.object({ id: z.string().uuid(), status: z.string() }),
});

const EvalResultsResponseSchema = z.object({ data: z.array(z.unknown()) });
const AutonomyDecisionsResponseSchema = z.object({ data: z.array(z.unknown()) });

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
/**
 * Names of the GLOBAL templates whose runs are conversational/assistant chatter,
 * not engineering work: the per-mention "Channel Assistant" turn/ambient-digest
 * template and the general "Channel Task" autonomous-execution template. Both are
 * hidden from the default `/runs` list. The CODE route of a channel task uses the
 * team's SWE template (a real implement → review → PR run) and is intentionally
 * NOT in this set — those runs stay visible like any other engineering run.
 */
const CHANNEL_TEMPLATE_NAMES = [CHANNEL_ASSISTANT_TEMPLATE_NAME, CHANNEL_TASK_TEMPLATE_NAME];

const ListRunsQuery = RunListPaginationQuery.extend({
  /**
   * Channel chatter runs (template names "Channel Assistant" / "Channel Task")
   * are excluded from the list by default so a busy channel can't bury
   * engineering runs. Opt in with `?includeChannel=true`.
   */
  includeChannel: booleanQueryParam(false),
  status: z.enum(WORKFLOW_RUN_STATUSES).optional(),
  templateId: z.string().uuid().optional(),
  workRequestId: z.string().uuid().optional(),
});

export const workflowRunRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // ── List runs ──
  app.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: ListRunsQuery, response: { 200: RunListResponseSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const { includeChannel, limit, offset, status, templateId, workRequestId } = request.query;
      const where: Prisma.WorkflowRunWhereInput = {
        ...buildWorkflowRunVisibilityFilter(user),
        ...(status ? { status } : {}),
        ...(templateId ? { templateId } : {}),
        ...(workRequestId ? { workRequestId } : {}),
        // Hide channel chatter runs unless explicitly opted in. An explicit
        // templateId filter already narrows to one template, so the exclusion
        // only matters for the unfiltered list.
        ...(includeChannel || templateId
          ? {}
          : { template: { name: { notIn: CHANNEL_TEMPLATE_NAMES } } }),
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
      schema: {
        params: RunIdParam,
        response: {
          200: CancelRunResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const run = await fastify.prisma.workflowRun.findFirst({
        where: { id: request.params.id, ...buildWorkflowRunVisibilityFilter(user) },
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
      // Guard the update with a status=RUNNING predicate so a race against a
      // concurrent terminal-state write (e.g. the workflow finishing between
      // the findFirst above and this update) can't clobber a completed run.
      const { count } = await fastify.prisma.workflowRun.updateMany({
        data: { endedAt: new Date(), status: 'CANCELLED' },
        where: { id: run.id, status: 'RUNNING' },
      });
      if (count === 0) {
        return reply.status(409).send({
          error: { code: 'RUN_NOT_RUNNING', message: 'Run reached a terminal state before cancel' },
        });
      }
      if (run.workflowId) {
        await fastify.prisma.activeWorkflow.updateMany({
          data: { currentStatus: 'CANCELLED' },
          where: { temporalWorkflowId: run.workflowId },
        });
      }
      fastify.temporal.cancelWorkflow(run.workflowId).catch((err: unknown) => {
        request.log.error({ err, workflowId: run.workflowId }, 'Temporal cancel signal failed');
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: user,
        after: { status: 'CANCELLED' },
        before: { status: run.status },
        entityId: run.id,
        entityType: 'WorkflowRun',
      });
      return { data: { id: run.id, status: 'CANCELLED' } };
    }
  );

  // ── Get captured eval signals for a run (P0 evals) ──
  app.get(
    '/:id/eval-results',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: {
        params: RunIdParam,
        response: { 200: EvalResultsResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const run = await fastify.prisma.workflowRun.findFirst({
        select: { id: true },
        where: { id: request.params.id, ...buildWorkflowRunVisibilityFilter(user) },
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
      const data: EvalResultDto[] = rows.map(projectEvalResult);
      return { data };
    }
  );

  // ── Get run detail (with steps + spec snapshot) ──
  app.get(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: {
        params: RunIdParam,
        querystring: RunDetailQuery,
        response: { 200: RunDetailResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { fullTraces } = request.query;
      const includeTraces = request.query.includeTraces || fullTraces;
      const run = await fastify.prisma.workflowRun.findFirst({
        include: {
          steps: { orderBy: [{ startedAt: 'asc' }, { attempt: 'asc' }] },
          template: { select: { name: true } },
          workRequest: {
            select: { description: true, externalTicketId: true, id: true },
          },
        },
        where: { id: request.params.id, ...buildWorkflowRunVisibilityFilter(user) },
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
          result: (run.contextSnapshot as { result?: unknown })?.result ?? null,
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
          tokensInputTotal: Number(run.tokensInputTotal),
          tokensOutputTotal: Number(run.tokensOutputTotal),
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

  // ── Get the governance audit trail for a run ──
  app.get(
    '/:id/autonomy-decisions',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: {
        params: RunIdParam,
        response: { 200: AutonomyDecisionsResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const run = await fastify.prisma.workflowRun.findFirst({
        select: { id: true },
        where: { id: request.params.id, ...buildWorkflowRunVisibilityFilter(user) },
      });
      if (!run) {
        return reply.status(404).send({
          error: { code: 'RUN_NOT_FOUND', message: 'Workflow run not found' },
        });
      }
      const rows = await fastify.prisma.autonomyDecision.findMany({
        orderBy: { createdAt: 'asc' },
        where: { runId: run.id },
      });
      const data = rows.map(projectAutonomyDecision);
      return { data };
    }
  );
};

export const stepRegistryRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Step palette catalog (for the web editor) ──
  fastify.get('/registry', { onRequest: requireAuth({ requiredRole: 'ENGINEER' }) }, async () => ({
    data: listSteps(),
  }));
};
