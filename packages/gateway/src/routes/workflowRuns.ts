import type { Prisma } from '@auto-swe/shared';
import { AGENT_RUN_TEMPLATE_ORIGIN } from '@auto-swe/shared/lib/agentRun';
import {
  CHANNEL_ASSISTANT_TEMPLATE_NAME,
  CHANNEL_TASK_TEMPLATE_NAME,
} from '@auto-swe/shared/lib/channelTask';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { EvalResultDto } from '@auto-swe/shared/types/api';
import { WORKFLOW_RUN_STATUSES } from '@auto-swe/shared/types/api';
import { listSteps } from '@auto-swe/shared/workflow';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { assertMcpWriteAllowed, mcpWriteAuditHook, mcpWriteBegin } from '../lib/mcpWriteGuard.js';
import { recordRunFinalized } from '../lib/metrics.js';
import { paginationQuery } from '../lib/pagination.js';
import { booleanQueryParam } from '../lib/queryParams.js';
import {
  buildWorkflowRunControlFilter,
  buildWorkflowRunVisibilityFilter,
} from '../lib/runVisibility.js';
import { isTerminalSignalError } from '../lib/temporalErrors.js';
import { requireAuth, requireUser } from '../plugins/auth.js';
import {
  AutonomyDecisionSchema,
  projectAutonomyDecision,
  projectEvalResult,
  projectRunSummary,
  RunListPaginationQuery,
} from './workflowProjections.js';

const RunIdParam = z.object({ id: z.string().uuid() });
const RunDetailQuery = z.object({
  /** Skip server-side trace payload trimming (forensic deep-dive only). */
  fullTraces: booleanQueryParam(false),
  /**
   * Include `specSnapshot`. The spec is fixed when the run starts, so a poller
   * that holds it asks for `false` and the server neither reads nor sends it.
   */
  includeSpec: booleanQueryParam(true),
  includeTraces: booleanQueryParam(false),
});

const RunTracesQuery = z.object({
  /**
   * Return only traces created at or after this instant. Inclusive so a row in
   * the cursor's own millisecond is not skipped; callers merge by trace id, so
   * the overlap is harmless. `createdAt` is the writing worker's clock when it
   * built the insert, not the commit time, so no cursor can promise every row
   * behind it has been read — `total` is what lets a caller notice a gap.
   */
  since: z.iso.datetime({ offset: true }).optional(),
});

const ErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const RunListResponseSchema = z.object({
  data: z.array(z.unknown()),
  meta: z.object({ limit: z.number(), offset: z.number(), total: z.number() }),
});

const RunDetailResponseSchema = z.object({ data: z.unknown() });
const RunTracesResponseSchema = z.object({
  data: z.array(z.unknown()),
  /**
   * The gateway's clock just before the read. A caller's next cursor can start
   * from here rather than from its newest trace, so an idle run's poll does
   * not re-read the last batch every time.
   */
  serverTime: z.iso.datetime(),
  /** Every trace the run has, counted in the same snapshot as `data`. */
  total: z.number().int(),
});

const CancelRunResponseSchema = z.object({
  data: z.object({ id: z.string().uuid(), status: z.string() }),
});

const EvalResultsResponseSchema = z.object({ data: z.array(z.unknown()) });
const AutonomyDecisionsResponseSchema = z.object({ data: z.array(AutonomyDecisionSchema) });
const AutonomyDecisionsQuery = paginationQuery({ defaultLimit: 100, maxLimit: 200 });

/** Max chars per string field in trace payloads returned by the polled run view. */
const TRACE_FIELD_CAP = 4_000;

/**
 * Trim large string fields out of trace payloads. LLM-response rows carry the
 * full system prompt + user message (often tens of KB including diffs) which
 * the run page polls every few seconds. `?fullTraces=true` bypasses the trim;
 * the run page offers it on demand when a trace reports `trimmed`.
 */
function trimTraceJson(value: unknown, onTrim: () => void): unknown {
  if (typeof value === 'string' && value.length > TRACE_FIELD_CAP) {
    onTrim();
    // Head *and* tail. A head-only cut drops precisely what the reader came
    // for: an offloaded tool result carries the failing line and its
    // `/workspace/.tool-output/` path at the end, and an LLM response's verdict
    // is at the end too. The cap is what bounds the polled payload; which end
    // it keeps is free.
    const head = Math.floor(TRACE_FIELD_CAP * 0.7);
    const tail = TRACE_FIELD_CAP - head;
    const elided = value.length - head - tail;
    return `${value.slice(0, head)}…[truncated ${elided} chars — refetch with ?fullTraces=true]…${value.slice(value.length - tail)}`;
  }
  if (Array.isArray(value)) {
    return value.map((v) => trimTraceJson(v, onTrim));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        trimTraceJson(v, onTrim),
      ])
    );
  }
  return value;
}

/** Trim both payloads of a trace, reporting whether anything was cut. */
function trimTracePayloads(
  t: { inputJson: unknown; outputJson: unknown },
  full: boolean
): { inputJson: unknown; outputJson: unknown; trimmed: boolean } {
  if (full) {
    return { inputJson: t.inputJson, outputJson: t.outputJson, trimmed: false };
  }
  let trimmed = false;
  const onTrim = () => {
    trimmed = true;
  };
  return {
    inputJson: trimTraceJson(t.inputJson, onTrim),
    outputJson: trimTraceJson(t.outputJson, onTrim),
    trimmed,
  };
}
/** The run page's view of one trace row; payloads trimmed unless `full`. */
function projectTrace(t: Prisma.AgentTraceGetPayload<object>, full: boolean) {
  return {
    ...trimTracePayloads(t, full),
    agentKey: t.agentKey,
    attempt: t.attempt,
    costUsd: t.costUsd,
    createdAt: t.createdAt,
    durationMs: t.durationMs,
    error: t.error,
    id: t.id,
    inputTokens: t.inputTokens,
    model: t.model,
    nodeId: t.nodeId,
    otelSpanId: t.otelSpanId,
    otelTraceId: t.otelTraceId,
    outputTokens: t.outputTokens,
    recordingId: t.recordingId,
    seq: t.seq,
    specNodeId: t.specNodeId,
    stepAttempt: t.stepAttempt,
    toolName: t.toolName,
    type: t.type,
  };
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
  scope: z.enum(['ALL', 'MINE', 'TEAM']).optional(),
  status: z.enum(WORKFLOW_RUN_STATUSES).optional(),
  templateId: z.string().uuid().optional(),
  templateVersion: z.coerce.number().int().positive().optional(),
  workRequestId: z.string().uuid().optional(),
});

export const workflowRunRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // ── List runs ──
  app.get(
    '/',
    {
      config: { mcpScope: 'read' },
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: ListRunsQuery, response: { 200: RunListResponseSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const {
        includeChannel,
        limit,
        offset,
        scope,
        status,
        templateId,
        templateVersion,
        workRequestId,
      } = request.query;
      const teamFilter = buildWorkflowRunVisibilityFilter(user, request.repoAccessGate);
      const visibilityFilter: Prisma.WorkflowRunWhereInput =
        user.role === 'ADMIN' && scope === 'ALL'
          ? {}
          : scope === 'MINE'
            ? { AND: [teamFilter, { workRequest: { requestedById: user.sub } }] }
            : teamFilter;
      const where: Prisma.WorkflowRunWhereInput = {
        ...visibilityFilter,
        ...(status ? { status } : {}),
        ...(templateId ? { templateId } : {}),
        ...(templateVersion ? { templateVersion } : {}),
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
            template: { select: { name: true, workspaceProvider: true } },
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
        data: rows.map((r) => projectRunSummary(r, user.sub)),
        meta: { limit, offset, total },
      };
    }
  );

  // ── Cancel a running workflow ──
  app.post(
    '/:id/cancel',
    {
      // An MCP write tool reaches this route through the bridge; `assertMcpWriteAllowed` below
      // is what bounds it, and the hook writes its audit row.
      config: { mcpScope: 'write' },
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      onSend: mcpWriteAuditHook,
      preValidation: mcpWriteBegin('cancel_run'),
      schema: {
        params: RunIdParam,
        response: {
          200: CancelRunResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          502: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const mcpWrite = await assertMcpWriteAllowed(request, reply, {
        tool: 'cancel_run',
      });
      if (mcpWrite.refused) {
        return mcpWrite.refused;
      }
      const run = await fastify.prisma.workflowRun.findFirst({
        include: { template: { select: { name: true, teamId: true } } },
        where: {
          id: request.params.id,
          ...buildWorkflowRunControlFilter(user, request.repoAccessGate),
        },
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
      // Temporal first, then the rows. Marking the run CANCELLED before the
      // cancel reached Temporal left a workflow still running — pushing,
      // spending — behind a dashboard that said it had stopped, whenever the
      // fire-and-forget cancel failed. An execution Temporal no longer knows
      // (never started, or already closed) has nothing left to cancel, so that
      // failure counts as success; any other failure leaves the row RUNNING
      // and reports 502 so the caller can retry.
      // Whether the workflow will finalize the run: true once Temporal has
      // accepted the cancel of a RunnableWorkflow run, whose cancellation path
      // finalizes it as CANCELLED in a non-cancellable scope; false when no
      // execution is left to do that. Channel turns (the global Channel
      // Assistant template) finalize in a cancellable scope, so a cancel
      // rejects their finalization outright — and they bill no org, so ending
      // them here loses nothing from the cap.
      const isChannelTurn =
        run.template?.teamId === null && run.template?.name === CHANNEL_ASSISTANT_TEMPLATE_NAME;
      let workflowFinalizes = false;
      if (run.workflowId) {
        try {
          await fastify.temporal.cancelWorkflow(run.workflowId);
          workflowFinalizes = !isChannelTurn;
        } catch (err) {
          if (!isTerminalSignalError(err)) {
            request.log.error({ err, workflowId: run.workflowId }, 'Temporal cancel failed');
            return sendError(
              reply,
              502,
              'TEMPORAL_CANCEL_FAILED',
              'Could not cancel the workflow in Temporal; the run was left RUNNING — try again'
            );
          }
        }
      }
      // Guard the update with a status=RUNNING predicate so a race against a
      // concurrent terminal-state write (e.g. the workflow finishing, or its
      // own cancellation finalisation landing first) can't clobber it.
      //
      // When the workflow will finalize the run, leave `endedAt` to it: the
      // run stays in flight for the org cap until `finalizeWorkflowRun` bills
      // its spend — including what it spends while it stops — to the org's
      // month, keeping this CANCELLED. Ending it here would drop that spend
      // from both sides of the cap. With no execution left, nothing else will
      // end the run, so this write does.
      const { count } = await fastify.prisma.workflowRun.updateMany({
        data: workflowFinalizes
          ? { status: 'CANCELLED' }
          : { endedAt: new Date(), status: 'CANCELLED' },
        where: { id: run.id, status: 'RUNNING' },
      });
      if (count > 0) {
        // This write cancelled the run, so it counts it; the workflow's
        // finalisation keeps the status and does not count it again. When
        // that finalisation lands first, it counts the run instead and this
        // guard skips it, so each run counts once.
        recordRunFinalized('CANCELLED', 'gateway');
      } else {
        // The workflow's own cancellation handler can finalise the run as
        // CANCELLED before this write — that is this cancel succeeding.
        const current = await fastify.prisma.workflowRun.findUnique({
          select: { status: true },
          where: { id: run.id },
        });
        if (current?.status !== 'CANCELLED') {
          return reply.status(409).send({
            error: {
              code: 'RUN_NOT_RUNNING',
              message: 'Run reached a terminal state before cancel',
            },
          });
        }
      }
      if (run.workflowId) {
        await fastify.prisma.activeWorkflow.updateMany({
          data: { currentStatus: 'CANCELLED' },
          where: { temporalWorkflowId: run.workflowId },
        });
      }
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
        where: {
          id: request.params.id,
          ...buildWorkflowRunVisibilityFilter(user, request.repoAccessGate),
        },
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

  // ── Traces created since a cursor (the run page's live tail) ──
  // A running run's page polls this plus the trace-free detail instead of
  // re-downloading every trace each tick. Payloads are always trimmed, like the
  // polled detail view; `?fullTraces=true` on the detail route is the one-shot
  // way to get them whole. `total` is counted in the same snapshot as the
  // page, so a caller holding fewer traces than `total` after merging knows a
  // row landed behind its cursor and must re-read them all.
  app.get(
    '/:id/traces',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: {
        params: RunIdParam,
        querystring: RunTracesQuery,
        response: { 200: RunTracesResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const run = await fastify.prisma.workflowRun.findFirst({
        select: { id: true },
        where: {
          id: request.params.id,
          ...buildWorkflowRunVisibilityFilter(user, request.repoAccessGate),
        },
      });
      if (!run) {
        return reply.status(404).send({
          error: { code: 'RUN_NOT_FOUND', message: 'Workflow run not found' },
        });
      }
      const { since } = request.query;
      const serverTime = new Date().toISOString();
      // One REPEATABLE READ snapshot, so a row committed between the two
      // statements cannot be counted without being returned (or vice versa).
      // The guard checks at execution, so the whole transaction runs exempted.
      const [traces, total] = await runUnscoped(
        'scoped by a run the caller was authorized to read',
        ['AgentTrace'],
        () =>
          fastify.prisma.$transaction(
            [
              fastify.prisma.agentTrace.findMany({
                orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }],
                where: {
                  runId: run.id,
                  ...(since ? { createdAt: { gte: new Date(since) } } : {}),
                },
              }),
              fastify.prisma.agentTrace.count({ where: { runId: run.id } }),
            ],
            { isolationLevel: 'RepeatableRead' }
          )
      );
      return { data: traces.map((t) => projectTrace(t, false)), serverTime, total };
    }
  );

  // ── Get run detail (with steps + spec snapshot) ──
  app.get(
    '/:id',
    {
      config: { mcpScope: 'read' },
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: {
        params: RunIdParam,
        querystring: RunDetailQuery,
        response: { 200: RunDetailResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { fullTraces, includeSpec } = request.query;
      const includeTraces = request.query.includeTraces || fullTraces;
      const run = await fastify.prisma.workflowRun.findFirst({
        include: {
          steps: { orderBy: [{ startedAt: 'asc' }, { attempt: 'asc' }] },
          template: { select: { name: true, origin: true, teamId: true } },
          workRequest: {
            select: { description: true, externalTicketId: true, id: true },
          },
        },
        omit: { specSnapshot: !includeSpec },
        where: {
          id: request.params.id,
          ...buildWorkflowRunVisibilityFilter(user, request.repoAccessGate),
        },
      });
      if (!run) {
        return reply.status(404).send({
          error: { code: 'RUN_NOT_FOUND', message: 'Workflow run not found' },
        });
      }
      const traces = includeTraces
        ? await runUnscoped(
            'scoped by a run the caller was authorized to read',
            ['AgentTrace'],
            () =>
              fastify.prisma.agentTrace.findMany({
                orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }],
                where: { runId: run.id },
              })
          )
        : [];
      return {
        data: {
          contextSnapshot: run.contextSnapshot,
          costUsdAccrued: run.costUsdAccrued,
          endedAt: run.endedAt,
          id: run.id,
          // Keyed on the template's reserved origin, never its display name: a team
          // template can carry any name, but not this origin.
          isAgentRun:
            run.template.teamId === null && run.template.origin === AGENT_RUN_TEMPLATE_ORIGIN,
          result: (run.contextSnapshot as { result?: unknown })?.result ?? null,
          // Absent, not null, when the caller declined it: null is a spec a run can have.
          specSnapshot: includeSpec ? (run as { specSnapshot?: unknown }).specSnapshot : undefined,
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
          traces: traces.map((t) => projectTrace(t, fullTraces)),
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
        querystring: AutonomyDecisionsQuery,
        response: { 200: AutonomyDecisionsResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const run = await fastify.prisma.workflowRun.findFirst({
        select: { id: true },
        where: {
          id: request.params.id,
          ...buildWorkflowRunVisibilityFilter(user, request.repoAccessGate),
        },
      });
      if (!run) {
        return reply.status(404).send({
          error: { code: 'RUN_NOT_FOUND', message: 'Workflow run not found' },
        });
      }
      const rows = await fastify.prisma.autonomyDecision.findMany({
        orderBy: { createdAt: 'asc' },
        skip: request.query.offset,
        take: request.query.limit,
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
