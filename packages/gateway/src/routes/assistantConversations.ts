import { resolveSetting } from '@auto-swe/shared/config';
import {
  ASSISTANT_TURN_NOT_STARTED_DETAIL,
  type AssistantMessageView,
  type AssistantPageContext,
  type AssistantToolStep,
  assistantErrorDetail,
  assistantPageContextSchema,
  isAssistantReplyOpen,
  MAX_ASSISTANT_MESSAGE_CHARS,
  MAX_ASSISTANT_TITLE_CHARS,
} from '@auto-swe/shared/lib/assistantConversation';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ApiCatalog } from '../lib/apiCatalog.js';
import { sendError } from '../lib/httpErrors.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/**
 * The in-app assistant's conversations (`docs/adr/in-app-assistant.md` D6, D8): the dashboard panel
 * lists, opens and posts to them here, and reads a reply as it streams.
 *
 * A conversation is private to its user: every query here filters on the caller's id, whatever
 * their role, and another user's conversation reads as not found. Posting a message records it,
 * creates the reply row PENDING, mints an assistant token bound to the user and the conversation,
 * and hands both to the conversation's workflow, which writes the reply into its row as the model
 * produces it.
 *
 * None of these routes is open to the assistant itself (`assistantPolicy.ts`) except the API
 * catalog and the status: an assistant that could post would start turns of its own.
 */

const ConversationParams = z.object({ id: z.uuid() });
const MessageParams = z.object({ id: z.uuid(), messageId: z.uuid() });

const PostBody = z.object({
  message: z.string().trim().min(1).max(MAX_ASSISTANT_MESSAGE_CHARS),
  pageContext: assistantPageContextSchema.optional(),
});

const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) });
const CatalogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(25).default(10),
  q: z.string().trim().max(100).default(''),
});

/** Messages returned when a conversation is opened; older ones are not shown. */
const OPEN_MESSAGE_LIMIT = 200;

/** How often an open stream re-reads its reply. */
const STREAM_POLL_MS = 300;
/** A stream ends after this long even if the reply never finishes; the panel reopens it. */
const STREAM_MAX_MS = 16 * 60 * 1000;
/** Streams one user may hold at once. Each polls the database while it is open. */
const MAX_STREAMS_PER_USER = 4;
const openStreams = new Map<string, number>();

const START_FAILED_TEXT = 'The assistant could not start. Please try again in a moment.';

type MessageRow = {
  id: string;
  role: 'USER' | 'ASSISTANT';
  content: string;
  steps: unknown;
  status: 'PENDING' | 'STREAMING' | 'COMPLETE' | 'FAILED';
  pageContext: unknown;
  error: string | null;
  createdAt: Date;
};

const messageSelect = {
  content: true,
  createdAt: true,
  error: true,
  id: true,
  pageContext: true,
  role: true,
  status: true,
  steps: true,
} as const;

function messageView(row: MessageRow): AssistantMessageView {
  const page = assistantPageContextSchema.safeParse(row.pageContext);
  return {
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    error: row.error,
    id: row.id,
    pageContext: page.success ? page.data : null,
    role: row.role,
    status: row.status,
    steps: Array.isArray(row.steps) ? (row.steps as AssistantToolStep[]) : [],
  };
}

function conversationView(row: { id: string; title: string; createdAt: Date; updatedAt: Date }) {
  return {
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function titleOf(message: string): string {
  const line = message.replace(/\s+/g, ' ').trim();
  return line.length <= MAX_ASSISTANT_TITLE_CHARS
    ? line
    : `${line.slice(0, MAX_ASSISTANT_TITLE_CHARS - 1).trimEnd()}…`;
}

export const assistantConversationRoutes: FastifyPluginAsync<{ catalog: ApiCatalog }> = async (
  fastify,
  { catalog }
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /**
   * Answer 403 (or 503 when the switch cannot be read) unless the assistant is on, and say whether
   * it did. A boolean, not the reply: a `FastifyReply` is thenable, so awaiting one would not
   * return it.
   */
  async function refusedWhileOff(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    let enabled: boolean;
    try {
      enabled = await resolveSetting('assistant.enabled');
    } catch (err) {
      request.log.error({ err }, 'assistant.enabled could not be read');
      sendError(reply, 503, 'ASSISTANT_UNAVAILABLE', 'The assistant is unavailable');
      return true;
    }
    if (!enabled) {
      sendError(reply, 403, 'ASSISTANT_DISABLED', 'The in-app assistant is turned off');
      return true;
    }
    return false;
  }

  /**
   * Record the user's message and an empty reply, and hand the turn to the conversation's
   * workflow. When the workflow cannot be reached the reply is marked FAILED, so the panel shows
   * the failure rather than waiting on a turn that will never run, and null comes back once the
   * 503 is sent.
   */
  async function startTurn(
    request: FastifyRequest,
    reply: FastifyReply,
    userId: string,
    conversationId: string,
    message: string,
    pageContext: AssistantPageContext | undefined
  ) {
    const [userMessage, replyRow] = await fastify.prisma.$transaction([
      fastify.prisma.assistantMessage.create({
        data: {
          content: message,
          conversationId,
          pageContext: pageContext ?? undefined,
          role: 'USER',
          status: 'COMPLETE',
        },
        select: messageSelect,
      }),
      fastify.prisma.assistantMessage.create({
        data: { conversationId, role: 'ASSISTANT', status: 'PENDING' },
        select: messageSelect,
      }),
      fastify.prisma.assistantConversation.update({
        data: { updatedAt: new Date() },
        select: { id: true },
        where: { id: conversationId },
      }),
    ]);
    let token: string | undefined;
    try {
      token = fastify.auth.signAssistantToken({ conversationId, userId });
      await fastify.temporal.sendAssistantTurn(
        { conversationId, userId },
        { replyId: replyRow.id, token }
      );
    } catch (err) {
      request.log.error({ conversationId, err }, 'assistant turn could not be started');
      const detail = assistantErrorDetail(err, ASSISTANT_TURN_NOT_STARTED_DETAIL);
      await fastify.prisma.assistantMessage.update({
        data: {
          error: START_FAILED_TEXT,
          // For admins only; the turn's token never belongs in a stored row.
          errorDetail: token ? detail.split(token).join('***') : detail,
          status: 'FAILED',
        },
        where: { id: replyRow.id },
      });
      sendError(reply, 503, 'ASSISTANT_UNAVAILABLE', START_FAILED_TEXT);
      return null;
    }
    return { reply: messageView(replyRow), userMessage: messageView(userMessage) };
  }

  // GET /api/v1/assistant/status — whether the panel should offer the assistant.
  app.get('/status', { onRequest: requireAuth() }, async () => {
    const enabled = await resolveSetting('assistant.enabled').catch(() => false);
    return { data: { enabled } };
  });

  // GET /api/v1/assistant/api-catalog — the routes the assistant may call, for its describeApi tool.
  app.get(
    '/api-catalog',
    { onRequest: requireAuth(), schema: { querystring: CatalogQuery } },
    async (request) => {
      const { limit, q } = request.query;
      return { routes: catalog.search(q, limit) };
    }
  );

  // GET /api/v1/assistant/conversations — the caller's open conversations, latest activity first.
  app.get(
    '/conversations',
    { onRequest: requireAuth(), schema: { querystring: ListQuery } },
    async (request) => {
      const user = requireUser(request);
      const rows = await fastify.prisma.assistantConversation.findMany({
        orderBy: { updatedAt: 'desc' },
        select: { createdAt: true, id: true, title: true, updatedAt: true },
        take: request.query.limit,
        where: { closedAt: null, userId: user.sub },
      });
      return { data: rows.map(conversationView) };
    }
  );

  // POST /api/v1/assistant/conversations — start a conversation with its first message.
  app.post(
    '/conversations',
    { onRequest: requireAuth(), schema: { body: PostBody } },
    async (request, reply) => {
      const user = requireUser(request);
      if (await refusedWhileOff(request, reply)) {
        return reply;
      }
      const { message, pageContext } = request.body;
      const conversation = await fastify.prisma.assistantConversation.create({
        data: { title: titleOf(message), userId: user.sub },
        select: { createdAt: true, id: true, title: true, updatedAt: true },
      });
      const turn = await startTurn(request, reply, user.sub, conversation.id, message, pageContext);
      if (!turn) {
        return reply;
      }
      return reply
        .code(201)
        .send({ data: { conversation: conversationView(conversation), ...turn } });
    }
  );

  // GET /api/v1/assistant/conversations/:id — one of the caller's conversations, with its messages.
  app.get(
    '/conversations/:id',
    { onRequest: requireAuth(), schema: { params: ConversationParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const conversation = await fastify.prisma.assistantConversation.findFirst({
        select: { createdAt: true, id: true, title: true, updatedAt: true },
        where: { closedAt: null, id: request.params.id, userId: user.sub },
      });
      if (!conversation) {
        return sendError(reply, 404, 'NOT_FOUND', 'Conversation not found');
      }
      const messages = await fastify.prisma.assistantMessage.findMany({
        orderBy: { createdAt: 'desc' },
        select: messageSelect,
        take: OPEN_MESSAGE_LIMIT,
        where: { conversationId: conversation.id },
      });
      return {
        data: {
          conversation: conversationView(conversation),
          messages: messages.reverse().map(messageView),
        },
      };
    }
  );

  // POST /api/v1/assistant/conversations/:id/messages — send the next message.
  app.post(
    '/conversations/:id/messages',
    { onRequest: requireAuth(), schema: { body: PostBody, params: ConversationParams } },
    async (request, reply) => {
      const user = requireUser(request);
      if (await refusedWhileOff(request, reply)) {
        return reply;
      }
      const conversation = await fastify.prisma.assistantConversation.findFirst({
        select: { id: true },
        where: { closedAt: null, id: request.params.id, userId: user.sub },
      });
      if (!conversation) {
        return sendError(reply, 404, 'NOT_FOUND', 'Conversation not found');
      }
      const busy = await fastify.prisma.assistantMessage.findFirst({
        select: { id: true },
        where: {
          conversationId: conversation.id,
          role: 'ASSISTANT',
          status: { in: ['PENDING', 'STREAMING'] },
        },
      });
      if (busy) {
        return sendError(
          reply,
          409,
          'TURN_IN_PROGRESS',
          'The assistant is still answering the previous message'
        );
      }
      const { message, pageContext } = request.body;
      const turn = await startTurn(request, reply, user.sub, conversation.id, message, pageContext);
      if (!turn) {
        return reply;
      }
      return reply.code(201).send({ data: turn });
    }
  );

  // POST /api/v1/assistant/conversations/:id/close — remove a conversation from the list. Its
  // assistant tokens stop working at once.
  app.post(
    '/conversations/:id/close',
    { onRequest: requireAuth(), schema: { params: ConversationParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const { count } = await fastify.prisma.assistantConversation.updateMany({
        data: { closedAt: new Date() },
        where: { closedAt: null, id: request.params.id, userId: user.sub },
      });
      if (count === 0) {
        return sendError(reply, 404, 'NOT_FOUND', 'Conversation not found');
      }
      return { data: { closed: true } };
    }
  );

  // GET /api/v1/assistant/conversations/:id/messages/:messageId/stream — a reply as it is written.
  // Server-sent events: a `message` event with the whole reply whenever it changes, then `done`.
  app.get(
    '/conversations/:id/messages/:messageId/stream',
    { onRequest: requireAuth(), schema: { params: MessageParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const where = {
        conversation: { userId: user.sub },
        conversationId: request.params.id,
        id: request.params.messageId,
        role: 'ASSISTANT' as const,
      };
      const first = await fastify.prisma.assistantMessage.findFirst({
        select: messageSelect,
        where,
      });
      if (!first) {
        return sendError(reply, 404, 'NOT_FOUND', 'Message not found');
      }
      const openCount = openStreams.get(user.sub) ?? 0;
      if (openCount >= MAX_STREAMS_PER_USER) {
        return sendError(
          reply,
          429,
          'TOO_MANY_STREAMS',
          `At most ${MAX_STREAMS_PER_USER} concurrent assistant streams per user`
        );
      }
      openStreams.set(user.sub, openCount + 1);

      reply.hijack();
      const res = reply.raw;
      // Hijacking skips Fastify's send path, so headers other plugins set on the reply (CORS) must
      // be copied across by hand, as the human-steps stream does.
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

      let closed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = Date.now() + STREAM_MAX_MS;
      const write = (event: string, data: unknown) => {
        if (!res.writableEnded) {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };

      return new Promise<void>((resolve) => {
        const finish = () => {
          if (closed) {
            return;
          }
          closed = true;
          if (timer) {
            clearTimeout(timer);
          }
          const remaining = (openStreams.get(user.sub) ?? 1) - 1;
          if (remaining <= 0) {
            openStreams.delete(user.sub);
          } else {
            openStreams.set(user.sub, remaining);
          }
          if (!res.writableEnded) {
            res.end();
          }
          resolve();
        };
        request.raw.once('close', finish);
        request.raw.once('error', finish);

        let lastSent = '';
        const send = (row: MessageRow) => {
          const view = messageView(row);
          const serialized = JSON.stringify(view);
          if (serialized !== lastSent) {
            lastSent = serialized;
            write('message', view);
          }
          if (!isAssistantReplyOpen(view.status)) {
            write('done', { status: view.status });
            finish();
            return false;
          }
          return true;
        };
        const poll = async () => {
          if (closed) {
            return;
          }
          if (Date.now() > deadline) {
            finish();
            return;
          }
          try {
            const row = await fastify.prisma.assistantMessage.findFirst({
              select: messageSelect,
              where,
            });
            if (!row) {
              finish();
              return;
            }
            if (!send(row)) {
              return;
            }
          } catch (err) {
            request.log.warn({ err }, 'assistant stream: poll failed');
          }
          if (!closed) {
            timer = setTimeout(poll, STREAM_POLL_MS);
          }
        };
        if (send(first)) {
          timer = setTimeout(poll, STREAM_POLL_MS);
        }
      });
    }
  );
};
