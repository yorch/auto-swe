import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { type HitlResolveErrorCode, resolveHitlStep } from '../lib/hitlResolve.js';
import { buildWorkflowHumanStepVisibilityFilter } from '../lib/runVisibility.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const StepIdParam = z.object({ id: z.string().uuid() });

const ListQuery = z.object({ status: z.enum(['PENDING', 'ALL']).default('PENDING') });

const RespondBody = z.object({
  action: z.string().min(1).max(50),
  value: z.unknown().optional(),
});

const ErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const StepListResponseSchema = z.object({ data: z.array(z.unknown()) });
const StepDetailResponseSchema = z.object({ data: z.unknown() });
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

const MAX_INBOX_STREAMS_PER_USER = 5;
/** user id → number of currently open `/inbox/stream` connections. */
const openInboxStreams = new Map<string, number>();

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
      const { status } = request.query;
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
        orderBy: { requestedAt: 'desc' },
        take: status === 'ALL' ? 200 : 100,
        where: {
          ...(status === 'ALL' ? {} : { status: 'PENDING' }),
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
          requestedAt: s.requestedAt,
          requiredApprovers: s.requiredApprovers,
          resolvedAt: s.resolvedAt,
          run: s.run,
          runId: s.runId,
          status: s.status,
          timeoutAt: s.timeoutAt,
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

      // Each stream polls the DB every 3 s for as long as it stays open and the
      // global rate limiter only sees the initial request, so bound how many a
      // single user may hold before the response is hijacked.
      const openCount = openInboxStreams.get(user.sub) ?? 0;
      if (openCount >= MAX_INBOX_STREAMS_PER_USER) {
        return reply.status(429).send({
          error: {
            code: 'TOO_MANY_STREAMS',
            message: `At most ${MAX_INBOX_STREAMS_PER_USER} concurrent inbox streams per user`,
          },
        });
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
