import {
  ASSISTANT_ACTION_CONFIRMED_TTL_MS,
  ASSISTANT_ACTION_PENDING_TTL_MS,
  assistantActionDigest,
} from '@auto-swe/shared/lib/assistantAction';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assistantAccess, policyPatternFor } from '../lib/assistantPolicy.js';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/**
 * Changes the in-app assistant proposes, and the user's answers to them (`docs/history/in-app-assistant.md`).
 *
 * The assistant proposes; only the person confirms or declines, on their own session. A confirmed
 * action is spent by `requireAuth` when the assistant makes the call it describes, so these routes
 * never perform the change themselves.
 */

const PROPOSABLE_METHODS = ['POST', 'PUT', 'PATCH'] as const;

const ProposeBody = z.object({
  /** A JSON object or array, exactly as the assistant will send it. */
  body: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
  method: z.enum(PROPOSABLE_METHODS),
  summary: z.string().trim().min(1).max(300),
  url: z
    .string()
    .max(2048)
    .regex(/^\/api\/v1\/[^\s#]*$/, 'must be a path under /api/v1/'),
});

const IdParams = z.object({ id: z.uuid() });

type ActionRow = {
  id: string;
  conversationId: string;
  method: string;
  url: string;
  body: unknown;
  summary: string;
  status: 'PENDING' | 'CONFIRMED' | 'DECLINED' | 'EXECUTED';
  expiresAt: Date;
  decidedAt: Date | null;
  executedAt: Date | null;
  createdAt: Date;
};

/** The row as a card shows it. A pending or confirmed row past its deadline reads as `EXPIRED`. */
function view(row: ActionRow, now = new Date()) {
  const lapsed = (row.status === 'PENDING' || row.status === 'CONFIRMED') && row.expiresAt <= now;
  return {
    body: row.body,
    conversationId: row.conversationId,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    executedAt: row.executedAt,
    expiresAt: row.expiresAt,
    id: row.id,
    method: row.method,
    status: lapsed ? 'EXPIRED' : row.status,
    summary: row.summary,
    url: row.url,
  };
}

export const assistantActionRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // POST /api/v1/assistant/actions — the assistant proposes a change for the user to confirm.
  app.post(
    '/',
    { onRequest: requireAuth(), schema: { body: ProposeBody } },
    async (request, reply) => {
      const user = requireUser(request);
      const assistant = request.assistant;
      if (!assistant) {
        return sendError(reply, 403, 'ASSISTANT_ONLY', 'Only the assistant proposes actions');
      }
      const { body, method, summary, url } = request.body;
      const pattern = policyPatternFor(method, url);
      if (!pattern || assistantAccess(method, pattern) !== 'confirm') {
        return sendError(
          reply,
          422,
          'ASSISTANT_ACTION_NOT_CONFIRMABLE',
          'The assistant cannot make this call, with or without confirmation'
        );
      }
      const row = await fastify.prisma.assistantAction.create({
        data: {
          ...(body !== undefined ? { body: body as object } : {}),
          conversationId: assistant.conversationId,
          digest: assistantActionDigest({ body, method, url }),
          expiresAt: new Date(Date.now() + ASSISTANT_ACTION_PENDING_TTL_MS),
          method,
          summary,
          url,
          userId: user.sub,
        },
      });
      return reply.status(201).send({ data: view(row) });
    }
  );

  // GET /api/v1/assistant/actions/:id — the user, or the assistant in the conversation it came from.
  app.get(
    '/:id',
    { onRequest: requireAuth(), schema: { params: IdParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const row = await fastify.prisma.assistantAction.findFirst({
        where: {
          id: request.params.id,
          userId: user.sub,
          ...(request.assistant ? { conversationId: request.assistant.conversationId } : {}),
        },
      });
      if (!row) {
        return sendError(reply, 404, 'NOT_FOUND', 'Action not found');
      }
      return { data: view(row) };
    }
  );

  const answer = (decision: 'CONFIRMED' | 'DECLINED') =>
    app.post(
      decision === 'CONFIRMED' ? '/:id/confirm' : '/:id/decline',
      { onRequest: requireAuth(), schema: { params: IdParams } },
      async (request, reply) => {
        const user = requireUser(request);
        // The policy table already refuses these to the assistant; this keeps that true if the
        // table is ever edited, because an assistant answering its own proposal is the whole risk.
        if (request.assistant) {
          return sendError(reply, 403, 'ASSISTANT_NOT_ALLOWED', 'Only the user answers an action');
        }
        const now = new Date();
        const answered = await fastify.prisma.assistantAction.updateMany({
          data: {
            decidedAt: now,
            status: decision,
            ...(decision === 'CONFIRMED'
              ? { expiresAt: new Date(now.getTime() + ASSISTANT_ACTION_CONFIRMED_TTL_MS) }
              : {}),
          },
          where: {
            expiresAt: { gt: now },
            id: request.params.id,
            status: 'PENDING',
            userId: user.sub,
          },
        });
        const row = await fastify.prisma.assistantAction.findFirst({
          where: { id: request.params.id, userId: user.sub },
        });
        if (!row) {
          return sendError(reply, 404, 'NOT_FOUND', 'Action not found');
        }
        if (answered.count !== 1) {
          return sendError(
            reply,
            409,
            'ASSISTANT_ACTION_NOT_PENDING',
            'This action has already been answered or has expired'
          );
        }
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: user,
          after: { method: row.method, status: row.status, summary: row.summary, url: row.url },
          before: { status: 'PENDING' },
          entityId: row.id,
          entityType: 'AssistantAction',
        });
        return { data: view(row, now) };
      }
    );
  answer('CONFIRMED');
  answer('DECLINED');
};
