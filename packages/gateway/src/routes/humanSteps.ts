import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { getCorsOrigins } from '../lib/env.js';
import { type HitlResolveErrorCode, resolveHitlStep } from '../lib/hitlResolve.js';
import { booleanQueryParam } from '../lib/queryParams.js';
import { buildWorkflowHumanStepVisibilityFilter } from '../lib/runVisibility.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const StepIdParam = z.object({ id: z.string().uuid() });

const ListQuery = z.object({
  overdue: booleanQueryParam(false),
  sort: z
    .enum(['requestedAt:asc', 'requestedAt:desc', 'timeoutAt:asc', 'timeoutAt:desc'])
    .default('requestedAt:desc'),
  status: z.enum(['PENDING', 'ALL']).default('PENDING'),
});

const RespondBody = z.object({
  action: z.string().min(1).max(50),
  value: z.unknown().optional(),
});

const ErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const HumanStepRunSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  workflowId: z.string(),
  workRequest: z
    .object({
      description: z.string().nullable(),
      externalTicketId: z.string().nullable(),
    })
    .nullable(),
});

const HumanStepListItemSchema = z.object({
  approvalsRemaining: z.number().int().min(0),
  context: z.unknown().nullable(),
  currentApprovers: z.number().int().min(0),
  description: z.string().nullable(),
  fields: z.unknown().nullable(),
  id: z.string().uuid(),
  kind: z.string(),
  nodeId: z.string(),
  options: z.unknown().nullable(),
  requestedAt: z.string(),
  requiredApprovers: z.number().int().min(1),
  resolvedAt: z.string().nullable(),
  run: HumanStepRunSchema.nullable(),
  runId: z.string().uuid(),
  status: z.string(),
  timeoutAt: z.string().nullable(),
  title: z.string(),
});

const HumanApprovalSchema = z.object({
  action: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().uuid().nullable(),
});

const HumanStepDetailSchema = z.object({
  _count: z.object({ humanApprovals: z.number().int() }),
  context: z.unknown().nullable(),
  description: z.string().nullable(),
  fields: z.unknown().nullable(),
  humanApprovals: z.array(HumanApprovalSchema),
  id: z.string().uuid(),
  kind: z.string(),
  nodeId: z.string(),
  options: z.unknown().nullable(),
  payload: z.unknown().nullable(),
  requestedAt: z.string(),
  requiredApprovers: z.number().int().min(1),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().uuid().nullable(),
  run: HumanStepRunSchema.nullable(),
  runId: z.string().uuid(),
  signalName: z.string(),
  status: z.string(),
  timeoutAt: z.string().nullable(),
  title: z.string(),
});

const StepListResponseSchema = z.object({ data: z.array(HumanStepListItemSchema) });
const StepDetailResponseSchema = z.object({ data: HumanStepDetailSchema });

const RespondResponseSchema = z.object({
  data: z.object({
    approvalsRemaining: z.number().int().min(0),
    currentApprovers: z.number().int().min(0),
    id: z.string().uuid(),
    requiredApprovers: z.number().int().min(1),
    signalSent: z.boolean(),
    status: z.string(),
  }),
});

function formatDate(value: Date): string;
function formatDate(value: unknown): string | null;
function formatDate(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return value;
  }
  return null;
}

/**
 * HTTP status per resolve-core error code. The resolve logic itself lives in
 * `lib/hitlResolve.ts` so the Slack interactivity handler can share it — this
 * map preserves the inbox route's original wire contract exactly.
 */
const STATUS_BY_CODE: Record<HitlResolveErrorCode, 200 | 400 | 404 | 409 | 502> = {
  ALREADY_RESOLVED: 409,
  INVALID_ACTION: 400,
  INVALID_VALUE: 400,
  NOT_FOUND: 404,
  RUN_NOT_RUNNING: 409,
  SIGNAL_FAILED: 502,
  UNKNOWN_KIND: 400,
};

export const humanStepRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // List pending (or all) human steps for current user
  app.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: ListQuery, response: { 200: StepListResponseSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const { overdue, sort, status } = request.query;
      const orderBy =
        sort === 'requestedAt:asc'
          ? { requestedAt: 'asc' as const }
          : sort === 'timeoutAt:asc'
            ? { timeoutAt: 'asc' as const }
            : sort === 'timeoutAt:desc'
              ? { timeoutAt: 'desc' as const }
              : { requestedAt: 'desc' as const };
      const steps = await fastify.prisma.workflowHumanStep.findMany({
        include: {
          _count: { select: { humanApprovals: true } },
          run: {
            select: {
              id: true,
              status: true,
              workflowId: true,
              workRequest: { select: { description: true, externalTicketId: true } },
            },
          },
        },
        orderBy,
        take: status === 'ALL' ? 200 : 100,
        where: {
          ...(status === 'ALL' ? {} : { status: 'PENDING' }),
          ...(overdue ? { timeoutAt: { lt: new Date() } } : {}),
          ...buildWorkflowHumanStepVisibilityFilter(user),
        },
      });
      return {
        data: steps.map((s) => ({
          approvalsRemaining: Math.max(0, s.requiredApprovers - s._count.humanApprovals),
          context: s.context,
          currentApprovers: s._count.humanApprovals,
          description: s.description,
          fields: s.fields,
          id: s.id,
          kind: s.kind,
          nodeId: s.nodeId,
          options: s.options,
          requestedAt: formatDate(s.requestedAt),
          requiredApprovers: s.requiredApprovers,
          resolvedAt: formatDate(s.resolvedAt),
          run: s.run,
          runId: s.runId,
          status: s.status,
          timeoutAt: formatDate(s.timeoutAt),
          title: s.title,
        })),
      };
    }
  );

  // SSE stream — emits 'change' events when the pending-step set changes
  app.get(
    '/stream',
    { onRequest: requireAuth({ requiredRole: 'ENGINEER' }) },
    async (request, reply) => {
      const user = requireUser(request);

      reply.hijack();

      const res = reply.raw;
      const origin = request.headers.origin;
      if (origin && getCorsOrigins().includes(origin)) {
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const write = (chunk: string) => {
        if (!res.writableEnded) {
          res.write(chunk);
        }
      };

      write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

      const fetchPendingIds = async (): Promise<Set<string>> => {
        const rows = await fastify.prisma.workflowHumanStep.findMany({
          select: { id: true },
          where: { status: 'PENDING', ...buildWorkflowHumanStepVisibilityFilter(user) },
        });
        return new Set(rows.map((r) => r.id));
      };

      let knownIds = await fetchPendingIds();
      let pollTimeout: ReturnType<typeof setTimeout> | null = null;
      let closed = false;

      const poll = async () => {
        try {
          const currentIds = await fetchPendingIds();
          const added = [...currentIds].filter((id) => !knownIds.has(id));
          const removed = [...knownIds].filter((id) => !currentIds.has(id));
          if (added.length > 0 || removed.length > 0) {
            write(`event: change\ndata: ${JSON.stringify({ added, removed })}\n\n`);
            knownIds = currentIds;
          }
        } catch {
          // swallow errors — client will reconnect on dropped connection
        }
        if (!closed) {
          pollTimeout = setTimeout(poll, 3000);
        }
      };
      pollTimeout = setTimeout(poll, 3000);

      const keepAliveInterval = setInterval(() => {
        write(': keepalive\n\n');
      }, 25000);

      return new Promise<void>((resolve) => {
        const cleanup = () => {
          closed = true;
          if (pollTimeout) {
            clearTimeout(pollTimeout);
          }
          clearInterval(keepAliveInterval);
          if (!res.writableEnded) {
            res.end();
          }
          resolve();
        };
        request.raw.once('close', cleanup);
        request.raw.once('error', cleanup);
      });
    }
  );

  // Get one step
  app.get(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: {
        params: StepIdParam,
        response: { 200: StepDetailResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const step = await fastify.prisma.workflowHumanStep.findFirst({
        include: {
          _count: { select: { humanApprovals: true } },
          humanApprovals: { select: { action: true, resolvedAt: true, resolvedBy: true } },
          run: {
            select: {
              id: true,
              status: true,
              workflowId: true,
              workRequest: { select: { description: true, externalTicketId: true } },
            },
          },
        },
        where: { id: request.params.id, ...buildWorkflowHumanStepVisibilityFilter(user) },
      });
      if (!step) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Human step not found' } });
      }
      return {
        data: {
          ...step,
          humanApprovals: step.humanApprovals.map((a) => ({
            ...a,
            resolvedAt: formatDate(a.resolvedAt),
          })),
          requestedAt: formatDate(step.requestedAt),
          resolvedAt: formatDate(step.resolvedAt),
          timeoutAt: formatDate(step.timeoutAt),
        },
      };
    }
  );

  // Respond to a pending step. The validation / atomic-resolve / signal-with-
  // rollback core is shared with the Slack `hitl_resolve` button handler via
  // lib/hitlResolve.ts.
  app.post(
    '/:id/respond',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: {
        body: RespondBody,
        params: StepIdParam,
        response: {
          200: RespondResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          502: ErrorResponseSchema,
        },
      },
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

      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: user,
        after: { action, resolvedBy: user.sub, status: result.status, value },
        before: { status: 'PENDING' },
        entityId: result.runId,
        entityType: 'WorkflowRun',
      });

      // `signalSent: false` means the decision was recorded but the workflow it
      // was meant for no longer exists — a 200 with a caveat, not a failure the
      // caller can retry into success (see lib/hitlResolve.ts).
      return {
        data: {
          approvalsRemaining: result.approvalsRemaining,
          currentApprovers: result.currentApprovers,
          id: result.stepId,
          requiredApprovers: result.requiredApprovers,
          signalSent: result.signalSent,
          status: result.status,
        },
      };
    }
  );
};
