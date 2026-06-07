import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';

const SECURITY_ACTIVITY_EVENTS = ['code_security.scan', 'llm.suspicious_output'] as const;

export type SecurityEventType =
  | 'SHELL_BLOCK'
  | 'FILE_BLOCK'
  | 'CONTENT_SECURITY_BLOCK'
  | 'CONTENT_SECURITY_WARN'
  | 'CODE_SECURITY'
  | 'LLM_SUSPICIOUS';

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
  if (trace.toolName === 'llm.suspicious_output') {
    return 'LLM_SUSPICIOUS';
  }
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

export const securityEventRoutes: FastifyPluginAsync = fp(async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/security-events',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { querystring: ListQuery },
    },
    async (request) => {
      const { limit, offset, runId, type } = request.query;

      // Build the base OR filter covering all security event shapes
      const baseOr = [
        { error: { startsWith: 'blocked by' } },
        { error: 'content security warning' },
        {
          AND: [{ type: 'activity_event' }, { toolName: { in: [...SECURITY_ACTIVITY_EVENTS] } }],
        },
      ];

      const where = {
        OR: baseOr,
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

      // Apply type filter client-side (derived field, not stored)
      const events = rows
        .map((t) => ({
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
        }))
        .filter((e) => !type || e.eventType === type);

      return { data: events };
    }
  );
});
