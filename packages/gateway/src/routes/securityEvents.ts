import { SECURITY_TRACE_ERRORS } from '@auto-swe/shared/lib/scannerCache';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { mapLimited } from '../lib/mapLimited.js';
import { paginationQuery } from '../lib/pagination.js';
import { requireAuth } from '../plugins/auth.js';

export type SecurityEventType =
  | 'SHELL_BLOCK'
  | 'FILE_BLOCK'
  | 'CONTENT_SECURITY_BLOCK'
  | 'CONTENT_SECURITY_WARN'
  | 'CODE_SECURITY'
  | 'LLM_SUSPICIOUS'
  | 'CHANNEL_SUSPICIOUS';

// Maps each SecurityEventType to the Prisma predicate that identifies it.
// Keeping this inline in the query ensures pagination is correct — the type
// filter is applied at the DB level, not post-fetch in JavaScript.

// Activity-event rows are matched by toolName within an AND[type, toolName] clause;
// block/warn rows are matched by the tag the worker's tools write — the shared
// `SECURITY_TRACE_ERRORS`, so a reworded tag cannot silently stop matching.
function activityEvent(toolName: string) {
  return { AND: [{ type: 'activity_event' }, { toolName }] };
}

const TYPE_PREDICATES: Record<SecurityEventType, object> = {
  CHANNEL_SUSPICIOUS: activityEvent('channel.suspicious_input'),
  CODE_SECURITY: activityEvent('code_security.scan'),
  CONTENT_SECURITY_BLOCK: { error: { startsWith: SECURITY_TRACE_ERRORS.CONTENT_BLOCK } },
  CONTENT_SECURITY_WARN: { error: SECURITY_TRACE_ERRORS.CONTENT_WARN },
  FILE_BLOCK: { error: { startsWith: SECURITY_TRACE_ERRORS.FILE_BLOCK } },
  LLM_SUSPICIOUS: activityEvent('llm.suspicious_output'),
  SHELL_BLOCK: { error: { startsWith: SECURITY_TRACE_ERRORS.SHELL_BLOCK } },
};

function classifyEvent(trace: {
  error: string | null;
  toolName: string | null;
  type: string;
}): SecurityEventType {
  if (trace.error?.startsWith(SECURITY_TRACE_ERRORS.SHELL_BLOCK)) {
    return 'SHELL_BLOCK';
  }
  if (trace.error?.startsWith(SECURITY_TRACE_ERRORS.FILE_BLOCK)) {
    return 'FILE_BLOCK';
  }
  if (trace.error?.startsWith(SECURITY_TRACE_ERRORS.CONTENT_BLOCK)) {
    return 'CONTENT_SECURITY_BLOCK';
  }
  if (trace.error === SECURITY_TRACE_ERRORS.CONTENT_WARN) {
    return 'CONTENT_SECURITY_WARN';
  }
  if (trace.type === 'activity_event' && trace.toolName === 'llm.suspicious_output') {
    return 'LLM_SUSPICIOUS';
  }
  if (trace.type === 'activity_event' && trace.toolName === 'channel.suspicious_input') {
    return 'CHANNEL_SUSPICIOUS';
  }
  // Remaining rows that passed the OR filter must be code_security.scan activity events
  return 'CODE_SECURITY';
}

/**
 * The gateway's pg pool holds 10 connections; the per-type counts run this many
 * at a time so the summary never holds most of it against auth traffic.
 */
const COUNT_CONCURRENCY = 3;

const ListQuery = paginationQuery({ defaultLimit: 50, maxLimit: 200 }).extend({
  runId: z.string().uuid().optional(),
  type: z
    .enum([
      'SHELL_BLOCK',
      'FILE_BLOCK',
      'CONTENT_SECURITY_BLOCK',
      'CONTENT_SECURITY_WARN',
      'CODE_SECURITY',
      'LLM_SUSPICIOUS',
      'CHANNEL_SUSPICIOUS',
    ])
    .optional(),
});

export const securityEventRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/security-events',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { querystring: ListQuery },
    },
    async (request) => {
      const { limit, offset, runId, type } = request.query;

      // Each SecurityEventType maps to specific DB-level predicates so the
      // type filter is pushed into the query and pagination is correct.
      const typeOr = type ? [TYPE_PREDICATES[type]] : Object.values(TYPE_PREDICATES);

      const where = {
        OR: typeOr,
        ...(runId ? { runId } : {}),
      };

      const [rows, total] = await Promise.all([
        fastify.prisma.agentTrace.findMany({
          include: {
            run: {
              select: {
                startedAt: true,
                workflowId: true,
                workRequest: { select: { externalTicketId: true, id: true } },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: limit,
          where,
        }),
        fastify.prisma.agentTrace.count({ where }),
      ]);

      const events = rows.map((t) => ({
        createdAt: t.createdAt,
        error: t.error,
        eventType: classifyEvent(t),
        // `run` is null for workflows that keep no WorkflowRun row (e.g. evals,
        // workflow authoring); the trace still carries its Temporal workflow ID.
        externalTicketId: t.run?.workRequest?.externalTicketId ?? null,
        id: t.id,
        inputJson: t.inputJson,
        nodeId: t.nodeId,
        outputJson: t.outputJson,
        runId: t.runId,
        startedAt: t.run?.startedAt ?? null,
        toolName: t.toolName,
        // Rows that predate the column carry their workflow ID on the run.
        workflowId: t.workflowId ?? t.run?.workflowId ?? null,
        workRequestId: t.run?.workRequest?.id ?? null,
      }));

      return { data: events, meta: { limit, offset, total } };
    }
  );

  // Per-type totals across every event, not just the page on screen. Each type
  // is its own predicate, so this is one count per type; it is a separate route
  // so paging through the list does not re-run them.
  app.get(
    '/security-events/summary',
    { onRequest: requireAuth({ requiredRole: 'ADMIN' }) },
    async () => {
      const types = Object.keys(TYPE_PREDICATES) as SecurityEventType[];
      const totals = await mapLimited(types, COUNT_CONCURRENCY, (type) =>
        fastify.prisma.agentTrace.count({ where: TYPE_PREDICATES[type] })
      );
      const counts = Object.fromEntries(types.map((t, i) => [t, totals[i]])) as Record<
        SecurityEventType,
        number
      >;
      return { data: counts };
    }
  );
};
