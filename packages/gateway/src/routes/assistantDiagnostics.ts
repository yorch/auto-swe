import { assistantConversationWorkflowId } from '@auto-swe/shared/lib/assistantConversation';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sendError } from '../lib/httpErrors.js';
import { paginationQuery } from '../lib/pagination.js';
import { requireAuth } from '../plugins/auth.js';

/**
 * Why in-app assistant replies failed, for admins: the FAILED replies across every user, each with
 * the cause the platform recorded (`AssistantMessage.errorDetail`) and, for one reply, the agent
 * trace rows its turn wrote (tagged with the reply, `AgentTrace.assistantMessageId`).
 *
 * A conversation is private to its user, so this shows what failed and why, never what was said:
 * no message text, no conversation title, and no trace `inputJson`/`outputJson` (they carry the
 * prompt, the user's message and tool results). The trace rows' errors, tool names, model, tokens
 * and timings are enough to tell a provider error from a tool failure or a timeout.
 */

const WindowQuery = z.object({
  since: z.iso.datetime().optional(),
  until: z.iso.datetime().optional(),
});

const ListQuery = paginationQuery({ defaultLimit: 50, maxLimit: 200 }).extend(WindowQuery.shape);

const FailureParams = z.object({ messageId: z.uuid() });

/** Trace rows returned for one failed turn; a turn that wrote more is cut. */
const MAX_TURN_TRACES = 500;

const failureSelect = {
  conversation: { select: { user: { select: { email: true, id: true, name: true } } } },
  conversationId: true,
  createdAt: true,
  error: true,
  errorDetail: true,
  id: true,
  updatedAt: true,
} as const;

type FailureRow = {
  id: string;
  conversationId: string;
  createdAt: Date;
  updatedAt: Date;
  error: string | null;
  errorDetail: string | null;
  conversation: { user: { id: string; email: string; name: string | null } };
};

function failureView(row: FailureRow) {
  return {
    conversationId: row.conversationId,
    createdAt: row.createdAt.toISOString(),
    error: row.error,
    errorDetail: row.errorDetail,
    failedAt: row.updatedAt.toISOString(),
    id: row.id,
    user: row.conversation.user,
    workflowId: assistantConversationWorkflowId(row.conversationId),
  };
}

export const assistantDiagnosticsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/platform/assistant/failures — FAILED replies, newest first.
  app.get(
    '/assistant/failures',
    { onRequest: requireAuth({ requiredRole: 'ADMIN' }), schema: { querystring: ListQuery } },
    async (request) => {
      const { limit, offset, since, until } = request.query;
      const where = {
        role: 'ASSISTANT' as const,
        status: 'FAILED' as const,
        ...(since || until
          ? {
              createdAt: {
                ...(since ? { gte: new Date(since) } : {}),
                ...(until ? { lt: new Date(until) } : {}),
              },
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        fastify.prisma.assistantMessage.findMany({
          // `id` breaks ties so offset pages neither repeat nor skip rows.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: failureSelect,
          skip: offset,
          take: limit,
          where,
        }),
        fastify.prisma.assistantMessage.count({ where }),
      ]);
      return { data: rows.map(failureView), meta: { limit, offset, total } };
    }
  );

  // GET /api/v1/platform/assistant/failures/:messageId — one failure and its turn's trace rows.
  app.get(
    '/assistant/failures/:messageId',
    { onRequest: requireAuth({ requiredRole: 'ADMIN' }), schema: { params: FailureParams } },
    async (request, reply) => {
      const row = await fastify.prisma.assistantMessage.findFirst({
        select: failureSelect,
        where: { id: request.params.messageId, role: 'ASSISTANT', status: 'FAILED' },
      });
      if (!row) {
        return sendError(reply, 404, 'NOT_FOUND', 'Assistant failure not found');
      }
      // A turn tags its rows with its reply (`AgentTrace.assistantMessageId`). Rows written before
      // the column existed carry no tag, so those are still found by time: a conversation's turns
      // run one at a time, so this turn's rows were written after the reply before it finished (it
      // may have waited behind that turn) and before this one was failed.
      const previous = await fastify.prisma.assistantMessage.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { updatedAt: true },
        where: {
          conversationId: row.conversationId,
          createdAt: { lt: row.createdAt },
          role: 'ASSISTANT',
        },
      });
      const from =
        previous && previous.updatedAt > row.createdAt ? previous.updatedAt : row.createdAt;
      const traces = await runUnscoped(
        'admin assistant diagnostics read one turn of any user',
        ['AgentTrace'],
        () =>
          fastify.prisma.agentTrace.findMany({
            orderBy: [{ createdAt: 'asc' }, { attempt: 'asc' }, { seq: 'asc' }],
            select: {
              agentKey: true,
              attempt: true,
              costUsd: true,
              createdAt: true,
              durationMs: true,
              error: true,
              id: true,
              inputTokens: true,
              model: true,
              otelTraceId: true,
              outputTokens: true,
              toolName: true,
              type: true,
            },
            take: MAX_TURN_TRACES,
            where: {
              OR: [
                { assistantMessageId: row.id },
                {
                  assistantMessageId: null,
                  createdAt: { gte: from, lte: row.updatedAt },
                  workflowId: assistantConversationWorkflowId(row.conversationId),
                },
              ],
            },
          })
      );
      return {
        data: {
          ...failureView(row),
          traces: traces.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })),
        },
      };
    }
  );
};
