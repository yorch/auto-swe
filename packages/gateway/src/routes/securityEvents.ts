import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';

export type SecurityEventType =
  | 'SHELL_BLOCK'
  | 'FILE_BLOCK'
  | 'CONTENT_SECURITY_BLOCK'
  | 'CONTENT_SECURITY_WARN'
  | 'CODE_SECURITY'
  | 'LLM_SUSPICIOUS';

// Maps each SecurityEventType to the Prisma predicate that identifies it.
// Keeping this inline in the query ensures pagination is correct — the type
// filter is applied at the DB level, not post-fetch in JavaScript.

// Activity-event rows are matched by toolName within an AND[type, toolName] clause;
// block/warn rows are matched by error string prefix or exact value.
function activityEvent(toolName: string) {
  return { AND: [{ type: 'activity_event' }, { toolName }] };
}

const TYPE_PREDICATES: Record<SecurityEventType, object> = {
  CODE_SECURITY: activityEvent('code_security.scan'),
  CONTENT_SECURITY_BLOCK: { error: { startsWith: 'blocked by content security' } },
  CONTENT_SECURITY_WARN: { error: 'content security warning' },
  FILE_BLOCK: { error: { startsWith: 'blocked by sensitive file' } },
  LLM_SUSPICIOUS: activityEvent('llm.suspicious_output'),
  SHELL_BLOCK: { error: { startsWith: 'blocked by shell command' } },
};

function classifyEvent(trace: {
  error: string | null;
  toolName: string | null;
  type: string;
}): SecurityEventType {
  if (trace.error?.startsWith('blocked by shell command')) {
    return 'SHELL_BLOCK';
  }
  if (trace.error?.startsWith('blocked by sensitive file')) {
    return 'FILE_BLOCK';
  }
  if (trace.error?.startsWith('blocked by content security')) {
    return 'CONTENT_SECURITY_BLOCK';
  }
  if (trace.error === 'content security warning') {
    return 'CONTENT_SECURITY_WARN';
  }
  if (trace.type === 'activity_event' && trace.toolName === 'llm.suspicious_output') {
    return 'LLM_SUSPICIOUS';
  }
  // Remaining rows that passed the OR filter must be code_security.scan activity events
  return 'CODE_SECURITY';
}

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  runId: z.string().uuid().optional(),
  type: z
    .enum([
      'SHELL_BLOCK',
      'FILE_BLOCK',
      'CONTENT_SECURITY_BLOCK',
      'CONTENT_SECURITY_WARN',
      'CODE_SECURITY',
      'LLM_SUSPICIOUS',
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

      const rows = await fastify.prisma.agentTrace.findMany({
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
      });

      const events = rows.map((t) => ({
        createdAt: t.createdAt,
        error: t.error,
        eventType: classifyEvent(t),
        externalTicketId: t.run.workRequest?.externalTicketId ?? null,
        id: t.id,
        inputJson: t.inputJson,
        nodeId: t.nodeId,
        outputJson: t.outputJson,
        runId: t.runId,
        startedAt: t.run.startedAt,
        toolName: t.toolName,
        workflowId: t.run.workflowId,
        workRequestId: t.run.workRequest?.id ?? null,
      }));

      return { data: events };
    }
  );
};
