import {
  classifySecurityTrace,
  MEMORY_DROPPED_EVENTS,
  MEMORY_WRITE_REFUSED_EVENTS,
  SECURITY_EVENT_TYPES,
  SECURITY_TRACE_ERRORS,
  type SecurityEventType,
} from '@auto-swe/shared/lib/scannerCache';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { mapLimited } from '../lib/mapLimited.js';
import { paginationQuery } from '../lib/pagination.js';
import { requireAuth } from '../plugins/auth.js';

// The type list is the shared one: the summary's predicate map and the `?type=` schema below
// are both keyed on it, so a type cannot be counted by one and rejected by the other.
export type { SecurityEventType };

// Maps each SecurityEventType to the Prisma predicate that identifies it.
// Keeping this inline in the query ensures pagination is correct — the type
// filter is applied at the DB level, not post-fetch in JavaScript.

// Activity-event rows are matched by toolName within an AND[type, toolName] clause;
// block/warn rows are matched by the tag the worker's tools write — the shared
// `SECURITY_TRACE_ERRORS`, so a reworded tag cannot silently stop matching.
function activityEvent(toolName: string | { in: string[] }) {
  return { AND: [{ type: 'activity_event' }, { toolName }] };
}

const TYPE_PREDICATES: Record<SecurityEventType, object> = {
  CHANNEL_SUSPICIOUS: activityEvent('channel.suspicious_input'),
  CODE_SECURITY: activityEvent('code_security.scan'),
  CONTENT_SECURITY_BLOCK: { error: { startsWith: SECURITY_TRACE_ERRORS.CONTENT_BLOCK } },
  CONTENT_SECURITY_WARN: { error: SECURITY_TRACE_ERRORS.CONTENT_WARN },
  FILE_BLOCK: { error: { startsWith: SECURITY_TRACE_ERRORS.FILE_BLOCK } },
  INSTRUCTION_FILE_BLOCK: {
    error: { startsWith: SECURITY_TRACE_ERRORS.INSTRUCTION_FILE_BLOCK },
  },
  LLM_SUSPICIOUS: activityEvent('llm.suspicious_output'),
  MEMORY_RECALL_DROPPED: activityEvent({ in: [...MEMORY_DROPPED_EVENTS] }),
  MEMORY_WRITE_REFUSED: activityEvent({ in: [...MEMORY_WRITE_REFUSED_EVENTS] }),
  SHELL_BLOCK: { error: { startsWith: SECURITY_TRACE_ERRORS.SHELL_BLOCK } },
};

/**
 * The gateway's pg pool holds 10 connections; the per-type counts run this many
 * at a time so the summary never holds most of it against auth traffic.
 */
const COUNT_CONCURRENCY = 3;

/** A window of event time: inclusive start, exclusive end, both ISO instants. */
const WindowQuery = z.object({
  since: z.iso.datetime().optional(),
  until: z.iso.datetime().optional(),
});

function createdAtWindow(since?: string, until?: string) {
  if (!since && !until) {
    return {};
  }
  return {
    createdAt: {
      ...(since ? { gte: new Date(since) } : {}),
      ...(until ? { lt: new Date(until) } : {}),
    },
  };
}

const ListQuery = paginationQuery({ defaultLimit: 50, maxLimit: 200 })
  .extend(WindowQuery.shape)
  .extend({
    runId: z.string().uuid().optional(),
    type: z.enum(SECURITY_EVENT_TYPES).optional(),
  });

export const securityEventRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/security-events',
    {
      onRequest: requireAuth({ capability: 'platform.audit.read' }),
      schema: { querystring: ListQuery },
    },
    async (request) => {
      const { limit, offset, runId, since, type, until } = request.query;

      // Each SecurityEventType maps to specific DB-level predicates so the
      // type filter is pushed into the query and pagination is correct.
      const typeOr = type ? [TYPE_PREDICATES[type]] : Object.values(TYPE_PREDICATES);

      const where = {
        OR: typeOr,
        ...(runId ? { runId } : {}),
        ...createdAtWindow(since, until),
      };

      // ADMIN-only feed across every tenant.
      const [rows, total] = await runUnscoped(
        'admin security feed spans every tenant',
        ['AgentTrace'],
        () =>
          Promise.all([
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
              // `id` breaks ties so offset pages neither repeat nor skip rows
              // written in one batch with the same `createdAt`.
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              skip: offset,
              take: limit,
              where,
            }),
            fastify.prisma.agentTrace.count({ where }),
          ])
      );

      const events = rows.flatMap((t) => {
        // The query's OR set is built from the same predicates the classifier names, so this is
        // null only for a row the endpoint should not report. It is never guessed at.
        const eventType = classifySecurityTrace(t);
        if (!eventType) {
          return [];
        }
        return [
          {
            createdAt: t.createdAt,
            error: t.error,
            eventType,
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
          },
        ];
      });

      return { data: events, meta: { limit, offset, total } };
    }
  );

  // Per-type totals, not just the page on screen. Each type is its own
  // predicate, so this is one count per type; it is a separate route so paging
  // through the list does not re-run them. With a window (`since` and `until`)
  // the counts are for that window and `previous` carries the same counts for
  // the window of equal length just before it, so a page can show a trend.
  app.get(
    '/security-events/summary',
    {
      onRequest: requireAuth({ capability: 'platform.audit.read' }),
      schema: { querystring: WindowQuery },
    },
    async (request) => {
      const { since, until } = request.query;
      const types = [...SECURITY_EVENT_TYPES];
      const countAll = (from?: string, to?: string) =>
        // ADMIN-only totals across every tenant, like the feed above.
        mapLimited(types, COUNT_CONCURRENCY, (type) =>
          runUnscoped('admin security summary spans every tenant', ['AgentTrace'], () =>
            fastify.prisma.agentTrace.count({
              where: { ...TYPE_PREDICATES[type], ...createdAtWindow(from, to) },
            })
          )
        ).then(
          (totals) =>
            Object.fromEntries(types.map((t, i) => [t, totals[i]])) as Record<
              SecurityEventType,
              number
            >
        );
      const data = await countAll(since, until);
      if (!since || !until) {
        return { data };
      }
      const length = Date.parse(until) - Date.parse(since);
      const previousSince = new Date(Date.parse(since) - length).toISOString();
      return { data, previous: await countAll(previousSince, since) };
    }
  );
};
