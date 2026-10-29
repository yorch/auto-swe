import type { Prisma } from '@auto-swe/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import {
  type HitlResolveErrorCode,
  resolvedViaForAuthMethod,
  resolveHitlStep,
} from '../lib/hitlResolve.js';
import { syncSlackHumanStepOutcome } from '../lib/hitlSlackSync.js';
import { sendError } from '../lib/httpErrors.js';
import { booleanQueryParam } from '../lib/queryParams.js';
import {
  buildWorkflowHumanStepControlFilter,
  buildWorkflowHumanStepVisibilityFilter,
} from '../lib/runVisibility.js';
import { sendTemporalUnavailable } from '../lib/temporalErrors.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const StepIdParam = z.object({ id: z.string().uuid() });

const ListQuery = z.object({
  /** Only pending steps the caller may answer and has not already answered. */
  actionable: booleanQueryParam(false),
  /**
   * Only steps the caller answered, of any kind and outcome: the step's `resolvedBy` is the caller
   * (single-approver answers, rejects, decisions, inputs, reviews, and the response that completed a
   * multi-approver step) or the caller has a recorded approval row on it. Only narrows the list.
   */
  answeredByMe: booleanQueryParam(false),
  /** Page size; defaults to 100 for `PENDING` and 200 for `ALL`. */
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  overdue: booleanQueryParam(false),
  runId: z.string().uuid().optional(),
  sort: z
    .enum(['requestedAt:asc', 'requestedAt:desc', 'timeoutAt:asc', 'timeoutAt:desc'])
    .default('requestedAt:desc'),
  status: z.enum(['PENDING', 'ALL']).default('PENDING'),
});

const RespondBody = z.object({
  action: z.string().min(1).max(50),
  /** An approver's note on an approval step; recorded and shown to the requester. */
  comment: z.string().max(2000).optional(),
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
  workRequestId: z.string().uuid().nullable(),
});

const HumanStepResponseSchema = z.object({
  action: z.string(),
  byName: z.string().nullable(),
  comment: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  /** A submitted review's text or a chosen decision option; null for other kinds. */
  value: z.string().nullable(),
});

const HumanStepListItemSchema = z.object({
  approvalsRemaining: z.number().int().min(0),
  context: z.unknown().nullable(),
  currentApprovers: z.number().int().min(0),
  description: z.string().nullable(),
  fields: z.unknown().nullable(),
  id: z.string().uuid(),
  kind: z.string(),
  /**
   * The action the caller answered with, or null: their recorded approval row's action, else the
   * stored action when the caller resolved the step.
   */
  myResponse: z.string().nullable(),
  nodeId: z.string(),
  options: z.unknown().nullable(),
  requestedAt: z.string(),
  requiredApprovers: z.number().int().min(1),
  resolvedAt: z.string().nullable(),
  /** Each recorded answer with its optional comment, oldest first. */
  responses: z.array(HumanStepResponseSchema),
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

const StepListResponseSchema = z.object({
  data: z.array(HumanStepListItemSchema),
  /** Present only when the request asked for a total: `answeredByMe`, `limit` or `offset`. */
  meta: z
    .object({
      limit: z.number().int(),
      offset: z.number().int(),
      /** Rows matching the filters, not capped by `limit`. */
      total: z.number().int().min(0),
    })
    .optional(),
});
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

function commentOf(value: unknown): string | null {
  if (value && typeof value === 'object' && 'comment' in value) {
    const comment = (value as { comment: unknown }).comment;
    return typeof comment === 'string' && comment ? comment : null;
  }
  return null;
}

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
const STATUS_BY_CODE: Record<HitlResolveErrorCode, 200 | 400 | 404 | 409 | 502 | 503> = {
  ALREADY_RESOLVED: 409,
  INVALID_ACTION: 400,
  INVALID_VALUE: 400,
  NOT_FOUND: 404,
  REASON_REQUIRED: 400,
  RUN_NOT_RUNNING: 409,
  SIGNAL_FAILED: 502,
  TEMPORAL_UNAVAILABLE: 503,
  UNKNOWN_KIND: 400,
};

const MAX_INBOX_STREAMS_PER_USER = 5;
/** user id → number of currently open `/inbox/stream` connections. */
const openInboxStreams = new Map<string, number>();

/**
 * Every response recorded on a step. Approval rows carry the approvers; a reject (or any
 * single-shot answer) on a multi-approver step resolves through the step's own payload and
 * writes no row, so that response is appended when no row already accounts for it.
 */
function stepResponses(s: {
  kind: string;
  humanApprovals: {
    action: string;
    resolvedAt: Date | null;
    resolvedBy: string | null;
    resolvedByUser: { email?: string | null; name: string | null } | null;
    value: unknown;
  }[];
  payload: unknown;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolvedByUser: { email?: string | null; name: string | null } | null;
  status: string;
}) {
  const rows = s.humanApprovals.map((a) => ({
    action: a.action,
    byName: a.resolvedByUser?.name ?? a.resolvedByUser?.email ?? null,
    comment: commentOf(a.value),
    resolvedAt: formatDate(a.resolvedAt),
    value: null,
  }));
  if (s.status !== 'RESOLVED' || !s.payload || typeof s.payload !== 'object') {
    return rows;
  }
  const action = String((s.payload as { action?: unknown }).action ?? 'respond');
  const resolver = (s.payload as { resolvedBy?: unknown }).resolvedBy ?? s.resolvedBy;
  const accounted = s.humanApprovals.some(
    (a) => a.action === action && (resolver == null || a.resolvedBy === resolver)
  );
  if (accounted) {
    return rows;
  }
  return [
    ...rows,
    {
      action,
      byName: s.resolvedByUser?.name ?? s.resolvedByUser?.email ?? null,
      comment: commentOf(s.payload),
      resolvedAt: formatDate(s.resolvedAt),
      value: answerValue(s.kind, s.payload),
    },
  ];
}

/**
 * What the caller answered. A multi-approver approval is a `humanApprovals` row; every other answer
 * (and the approval that completes the step) resolves through the step itself, whose stored payload
 * holds the action. A step resolved by a timeout or by someone else is not the caller's.
 */
function myResponseOf(
  s: {
    humanApprovals: { action: string; resolvedBy: string | null }[];
    payload: unknown;
    resolvedBy: string | null;
    status: string;
  },
  userId: string
): string | null {
  const row = s.humanApprovals.find((a) => a.resolvedBy === userId);
  if (row) {
    return row.action;
  }
  if (s.status !== 'RESOLVED' || s.resolvedBy !== userId) {
    return null;
  }
  const action = (s.payload as { action?: unknown } | null)?.action;
  return typeof action === 'string' && action ? action : 'respond';
}

/** The answer text a requester can read: a review's notes or the option a decision picked. */
function answerValue(kind: string, payload: unknown): string | null {
  if (kind !== 'REVIEW' && kind !== 'DECISION') {
    return null;
  }
  const value = (payload as { value?: unknown }).value;
  return typeof value === 'string' && value ? value : null;
}

export const humanStepRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // List pending (or all) human steps for current user
  app.get(
    '/',
    {
      config: { mcpScope: 'read' },
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: ListQuery, response: { 200: StepListResponseSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const { actionable, answeredByMe, limit, offset, overdue, sort, status, runId } =
        request.query;
      const pageSize = limit ?? (status === 'ALL' ? 200 : 100);
      const orderBy =
        sort === 'requestedAt:asc'
          ? { requestedAt: 'asc' as const }
          : sort === 'timeoutAt:asc'
            ? { timeoutAt: 'asc' as const }
            : sort === 'timeoutAt:desc'
              ? { timeoutAt: 'desc' as const }
              : { requestedAt: 'desc' as const };
      const where: Prisma.WorkflowHumanStepWhereInput = {
        ...(status === 'ALL' ? {} : { status: 'PENDING' as const }),
        ...(runId ? { runId } : {}),
        ...(overdue ? { timeoutAt: { lt: new Date() } } : {}),
        // "Actionable" is control, not visibility: a step on a run the caller can
        // see but not answer is not waiting on them. A step they already approved
        // is waiting on someone else, and an expired one cannot be answered.
        ...(actionable
          ? {
              humanApprovals: { none: { resolvedBy: user.sub } },
              OR: [{ timeoutAt: null }, { timeoutAt: { gt: new Date() } }],
              status: 'PENDING' as const,
              ...buildWorkflowHumanStepControlFilter(user, request.repoAccessGate),
            }
          : buildWorkflowHumanStepVisibilityFilter(user, request.repoAccessGate)),
        // Under AND so it can only narrow, whatever the filters above spread. A timeout or
        // someone else's answer leaves neither `resolvedBy` nor an approval row for the caller.
        ...(answeredByMe
          ? {
              AND: [
                {
                  OR: [
                    { resolvedBy: user.sub },
                    { humanApprovals: { some: { resolvedBy: user.sub } } },
                  ],
                },
              ],
            }
          : {}),
      };
      // The count is a second query on the hottest HITL read (the sidebar badge polls it), so it
      // runs only for a caller that asked for a total.
      const wantsTotal = answeredByMe || limit !== undefined || offset !== undefined;
      const skip = offset ?? 0;
      const [total, steps] = await Promise.all([
        wantsTotal ? fastify.prisma.workflowHumanStep.count({ where }) : Promise.resolve(null),
        fastify.prisma.workflowHumanStep.findMany({
          include: {
            _count: { select: { humanApprovals: true } },
            humanApprovals: {
              orderBy: { resolvedAt: 'asc' },
              select: {
                action: true,
                resolvedAt: true,
                resolvedBy: true,
                resolvedByUser: { select: { email: true, name: true } },
                value: true,
              },
            },
            resolvedByUser: { select: { email: true, name: true } },
            run: {
              select: {
                id: true,
                status: true,
                workflowId: true,
                workRequest: { select: { description: true, externalTicketId: true } },
                workRequestId: true,
              },
            },
          },
          orderBy,
          skip,
          take: pageSize,
          where,
        }),
      ]);
      return {
        data: steps.map((s) => ({
          approvalsRemaining: Math.max(0, s.requiredApprovers - s._count.humanApprovals),
          context: s.context,
          currentApprovers: s._count.humanApprovals,
          description: s.description,
          fields: s.fields,
          id: s.id,
          kind: s.kind,
          myResponse: myResponseOf(s, user.sub),
          nodeId: s.nodeId,
          options: s.options,
          requestedAt: formatDate(s.requestedAt),
          requiredApprovers: s.requiredApprovers,
          resolvedAt: formatDate(s.resolvedAt),
          responses: stepResponses(s),
          run: s.run,
          runId: s.runId,
          status: s.status,
          timeoutAt: formatDate(s.timeoutAt),
          title: s.title,
        })),
        ...(total === null ? {} : { meta: { limit: pageSize, offset: skip, total } }),
      };
    }
  );

  // SSE stream — emits 'change' events when the pending-step set changes
  app.get(
    '/stream',
    { onRequest: requireAuth({ requiredRole: 'ENGINEER' }) },
    async (request, reply) => {
      const user = requireUser(request);

      // Each stream polls the DB every 3 s for as long as it stays open and the
      // global rate limiter only sees the initial request, so bound how many a
      // single user may hold before the response is hijacked.
      const openCount = openInboxStreams.get(user.sub) ?? 0;
      if (openCount >= MAX_INBOX_STREAMS_PER_USER) {
        return sendError(
          reply,
          429,
          'TOO_MANY_STREAMS',
          `At most ${MAX_INBOX_STREAMS_PER_USER} concurrent inbox streams per user`
        );
      }
      openInboxStreams.set(user.sub, openCount + 1);
      const releaseStream = () => {
        const remaining = (openInboxStreams.get(user.sub) ?? 1) - 1;
        if (remaining <= 0) {
          openInboxStreams.delete(user.sub);
        } else {
          openInboxStreams.set(user.sub, remaining);
        }
      };

      reply.hijack();

      const res = reply.raw;
      // Hijacking bypasses Fastify's send path, so headers other plugins set on
      // the *reply* (notably @fastify/cors's Access-Control-Allow-Origin from
      // its onRequest hook) would never reach the socket. Without them the
      // browser's EventSource is blocked by CORS on every cross-origin
      // deployment, reconnects in a tight loop and trips the rate limiter.
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) {
          res.setHeader(name, value as string | number | string[]);
        }
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
          where: {
            status: 'PENDING',
            ...buildWorkflowHumanStepVisibilityFilter(user, request.repoAccessGate),
          },
        });
        return new Set(rows.map((r) => r.id));
      };

      let knownIds: Set<string>;
      try {
        knownIds = await fetchPendingIds();
      } catch (err) {
        // After hijack() Fastify cannot answer for us; end the stream so the
        // browser EventSource reconnects instead of hanging on a dead socket.
        request.log.warn({ err }, 'inbox stream: initial fetch failed');
        releaseStream();
        res.end();
        return;
      }
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
        } catch (err) {
          // Keep the stream open (the next poll may succeed) but say so — a
          // persistently failing DB otherwise looks like a silently frozen inbox.
          request.log.warn({ err }, 'inbox stream: poll failed');
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
          if (closed) {
            return;
          }
          closed = true;
          releaseStream();
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
              workRequestId: true,
            },
          },
        },
        where: {
          id: request.params.id,
          ...buildWorkflowHumanStepVisibilityFilter(user, request.repoAccessGate),
        },
      });
      if (!step) {
        return sendError(reply, 404, 'NOT_FOUND', 'Human step not found');
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
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { action, comment, value } = request.body;

      const result = await resolveHitlStep(
        {
          gate: request.repoAccessGate,
          log: request.log,
          prisma: fastify.prisma,
          temporal: fastify.temporal,
        },
        request.params.id,
        action,
        value,
        { ...user, via: resolvedViaForAuthMethod(request.authMethod) },
        comment
      );

      if (!result.ok) {
        if (result.code === 'TEMPORAL_UNAVAILABLE') {
          return sendTemporalUnavailable(reply);
        }
        return sendError(reply, STATUS_BY_CODE[result.code], result.code, result.message);
      }

      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: user,
        after: {
          action,
          ...(comment?.trim() ? { comment: comment.trim() } : {}),
          resolvedBy: user.sub,
          status: result.status,
          value,
        },
        before: { status: 'PENDING' },
        entityId: result.runId,
        entityType: 'WorkflowRun',
      });

      // Show the decision (and the approver's note) on the Slack message that announced the step.
      if (result.status === 'RESOLVED') {
        // Not awaited: the answer is already recorded and this never throws.
        void syncSlackHumanStepOutcome(
          { log: request.log, prisma: fastify.prisma },
          result.stepId,
          { action, comment, userId: user.sub, value }
        );
      }

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
