import { ASSISTANT_TOKEN_PREFIX } from '@auto-swe/shared/lib/assistantAction';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiCatalog } from '../lib/apiCatalog.js';
import { _resetAuthCachesForTests, requireAuth } from '../plugins/auth.js';
import {
  assistantBearer,
  buildAssistantApp,
  CONVERSATION_ID,
  makeAssistantPrisma,
  personBearer,
  USER_ID,
} from '../test/assistantApp.js';
import { assistantConversationRoutes } from './assistantConversations.js';

const settings = vi.hoisted(() => ({ resolveSetting: vi.fn() }));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: settings.resolveSetting }));
vi.mock('@auto-swe/shared/lib/repoAccessGate', () => ({
  resolveRepoAccessGateOrLastKnown: async () => ({ mode: 'off', staleAfterHours: 0 }),
}));

const PREFIX = '/api/v1/assistant';
const REPLY_ID = '00000000-0000-4000-8000-0000000000e2';
const USER_MESSAGE_ID = '00000000-0000-4000-8000-0000000000e1';
const NOW = new Date('2026-10-14T10:00:00Z');

function message(overrides: Record<string, unknown> = {}) {
  return {
    content: '',
    createdAt: NOW,
    error: null,
    id: REPLY_ID,
    pageContext: null,
    role: 'ASSISTANT',
    status: 'PENDING',
    steps: [],
    ...overrides,
  };
}

const conversation = {
  createdAt: NOW,
  id: CONVERSATION_ID,
  title: 'How do I',
  titleSource: 'FIRST_MESSAGE',
  updatedAt: NOW,
};

function makePrisma() {
  const base = makeAssistantPrisma();
  const prisma = {
    ...base,
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    assistantConversation: {
      ...base.assistantConversation,
      create: vi.fn().mockResolvedValue(conversation),
      findMany: vi.fn().mockResolvedValue([conversation]),
      update: vi.fn().mockResolvedValue({ id: CONVERSATION_ID }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    assistantMessage: {
      create: vi.fn(async ({ data }: { data: { role: string } }) =>
        data.role === 'USER'
          ? message({ content: 'hi', id: USER_MESSAGE_ID, role: 'USER', status: 'COMPLETE' })
          : message()
      ),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  return prisma;
}

describe('assistant conversation routes', () => {
  let app: FastifyInstance;
  let prisma: ReturnType<typeof makePrisma>;
  const temporal = { nameAssistantConversation: vi.fn(), sendAssistantTurn: vi.fn() };
  const catalog = new ApiCatalog();

  beforeEach(async () => {
    _resetAuthCachesForTests();
    settings.resolveSetting.mockReset().mockResolvedValue(true);
    temporal.sendAssistantTurn.mockReset().mockResolvedValue(undefined);
    temporal.nameAssistantConversation.mockReset().mockResolvedValue(undefined);
    prisma = makePrisma();
    app = await buildAssistantApp(prisma as never, async (a) => {
      a.decorate('temporal', temporal as never);
      await a.register(assistantConversationRoutes, { catalog, prefix: PREFIX });
    });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /conversations', () => {
    it('records the message and an empty reply, and hands the turn to the workflow', async () => {
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'POST',
        payload: {
          message: 'How do I connect GitHub?',
          pageContext: { entityId: 'abc', entityType: 'run', route: '/runs/abc' },
        },
        url: `${PREFIX}/conversations`,
      });
      expect(res.statusCode).toBe(201);
      const body = res.json().data;
      expect(body.conversation.id).toBe(CONVERSATION_ID);
      expect(body.reply).toMatchObject({ id: REPLY_ID, role: 'ASSISTANT', status: 'PENDING' });
      expect(prisma.assistantConversation.create.mock.calls[0][0].data).toEqual({
        title: 'How do I connect GitHub?',
        userId: USER_ID,
      });
      const [userCreate, replyCreate] = prisma.assistantMessage.create.mock.calls.map(
        (c) => c[0].data
      );
      expect(userCreate).toMatchObject({
        content: 'How do I connect GitHub?',
        pageContext: { entityId: 'abc', entityType: 'run', route: '/runs/abc' },
        role: 'USER',
      });
      expect(replyCreate).toMatchObject({ role: 'ASSISTANT', status: 'PENDING' });

      expect(temporal.sendAssistantTurn).toHaveBeenCalledTimes(1);
      const [input, turn] = temporal.sendAssistantTurn.mock.calls[0];
      expect(input).toEqual({ conversationId: CONVERSATION_ID, userId: USER_ID });
      expect(turn.replyId).toBe(REPLY_ID);
      expect(turn.token.startsWith(ASSISTANT_TOKEN_PREFIX)).toBe(true);
      expect(app.auth.verifyAssistantTokenClaims(turn.token)).toMatchObject({
        conversationId: CONVERSATION_ID,
        sub: USER_ID,
      });
    });

    it('refuses while the assistant is off, and records nothing', async () => {
      settings.resolveSetting.mockResolvedValue(false);
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'POST',
        payload: { message: 'hi' },
        url: `${PREFIX}/conversations`,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ASSISTANT_DISABLED');
      expect(prisma.assistantConversation.create).not.toHaveBeenCalled();
    });

    it('marks the reply failed when the workflow cannot be reached', async () => {
      temporal.sendAssistantTurn.mockRejectedValue(new Error('temporal down'));
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'POST',
        payload: { message: 'hi' },
        url: `${PREFIX}/conversations`,
      });
      expect(res.statusCode).toBe(503);
      expect(prisma.assistantMessage.update).toHaveBeenCalledWith({
        data: expect.objectContaining({
          errorDetail:
            'The turn could not be handed to the conversation workflow: Error: temporal down',
          status: 'FAILED',
        }),
        where: { id: REPLY_ID },
      });
    });

    it('rejects a page context that is not a dashboard path', async () => {
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'POST',
        payload: { message: 'hi', pageContext: { route: 'https://evil.example/' } },
        url: `${PREFIX}/conversations`,
      });
      expect(res.statusCode).toBe(400);
    });

    it('is never open to the assistant itself', async () => {
      const res = await app.inject({
        headers: { authorization: assistantBearer(app) },
        method: 'POST',
        payload: { message: 'start another turn' },
        url: `${PREFIX}/conversations/${CONVERSATION_ID}/messages`,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ASSISTANT_NOT_ALLOWED');
      expect(temporal.sendAssistantTurn).not.toHaveBeenCalled();
    });
  });

  describe('POST /conversations/:id/messages', () => {
    it("is not found for another user's or a closed conversation", async () => {
      prisma.assistantConversation.findFirst.mockImplementation(async (args) =>
        args?.where?.userId === USER_ID && args.where.closedAt === null ? null : conversation
      );
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'POST',
        payload: { message: 'hi' },
        url: `${PREFIX}/conversations/${CONVERSATION_ID}/messages`,
      });
      expect(res.statusCode).toBe(404);
    });

    it('refuses a second message while a reply is still being written', async () => {
      prisma.assistantMessage.findFirst.mockResolvedValue({ id: REPLY_ID });
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'POST',
        payload: { message: 'and another thing' },
        url: `${PREFIX}/conversations/${CONVERSATION_ID}/messages`,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('TURN_IN_PROGRESS');
    });
  });

  describe('GET /conversations/:id', () => {
    it('returns the messages oldest first, scoped to the caller', async () => {
      prisma.assistantConversation.findFirst.mockResolvedValue(conversation);
      prisma.assistantMessage.findMany.mockResolvedValue([
        message({ content: 'answer', status: 'COMPLETE' }),
        message({ content: 'question', id: USER_MESSAGE_ID, role: 'USER', status: 'COMPLETE' }),
      ]);
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'GET',
        url: `${PREFIX}/conversations/${CONVERSATION_ID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.messages.map((m: { content: string }) => m.content)).toEqual([
        'question',
        'answer',
      ]);
      expect(prisma.assistantConversation.findFirst.mock.calls.at(-1)?.[0].where).toEqual({
        closedAt: null,
        id: CONVERSATION_ID,
        userId: USER_ID,
      });
    });
  });

  describe('PATCH /conversations/:id', () => {
    it("renames the caller's conversation and marks the title as theirs", async () => {
      prisma.assistantConversation.findFirst.mockResolvedValue({
        ...conversation,
        title: 'GitHub App setup',
      });
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'PATCH',
        payload: { title: '  GitHub\n App   setup ' },
        url: `${PREFIX}/conversations/${CONVERSATION_ID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ id: CONVERSATION_ID, title: 'GitHub App setup' });
      expect(prisma.assistantConversation.updateMany).toHaveBeenCalledWith({
        data: { title: 'GitHub App setup', titleSource: 'USER' },
        where: { closedAt: null, id: CONVERSATION_ID, userId: USER_ID },
      });
    });

    it('cuts a long title to the stored length', async () => {
      prisma.assistantConversation.findFirst.mockResolvedValue(conversation);
      await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'PATCH',
        payload: { title: 'x'.repeat(120) },
        url: `${PREFIX}/conversations/${CONVERSATION_ID}`,
      });
      const { title } = prisma.assistantConversation.updateMany.mock.calls[0]?.[0].data ?? {};
      expect(title).toHaveLength(80);
      expect(title.endsWith('…')).toBe(true);
    });

    it('refuses a title with no text', async () => {
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'PATCH',
        payload: { title: ' \n ' },
        url: `${PREFIX}/conversations/${CONVERSATION_ID}`,
      });
      expect(res.statusCode).toBe(400);
      expect(prisma.assistantConversation.updateMany).not.toHaveBeenCalled();
    });

    it("is not found for another user's or a closed conversation", async () => {
      prisma.assistantConversation.updateMany.mockResolvedValue({ count: 0 });
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'PATCH',
        payload: { title: 'Mine now' },
        url: `${PREFIX}/conversations/${CONVERSATION_ID}`,
      });
      expect(res.statusCode).toBe(404);
    });

    it('works while the assistant is off, like closing does', async () => {
      settings.resolveSetting.mockResolvedValue(false);
      prisma.assistantConversation.findFirst.mockResolvedValue(conversation);
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'PATCH',
        payload: { title: 'Renamed' },
        url: `${PREFIX}/conversations/${CONVERSATION_ID}`,
      });
      expect(res.statusCode).toBe(200);
    });

    it('is refused to the assistant itself', async () => {
      const res = await app.inject({
        headers: { authorization: assistantBearer(app) },
        method: 'PATCH',
        payload: { title: 'Renamed by the model' },
        url: `${PREFIX}/conversations/${CONVERSATION_ID}`,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ASSISTANT_NOT_ALLOWED');
      expect(prisma.assistantConversation.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('POST /conversations/:id/title/reset', () => {
    const url = `${PREFIX}/conversations/${CONVERSATION_ID}/title/reset`;

    beforeEach(() => {
      prisma.assistantConversation.findFirst.mockResolvedValue({
        ...conversation,
        title: 'My name for it',
        titleSource: 'USER',
      });
      prisma.assistantMessage.findFirst.mockResolvedValue({
        content: '  How do I\n connect GitHub? ',
      });
    });

    it('puts back the first message as the title and asks the model to name it now', async () => {
      prisma.assistantConversation.findFirst
        .mockResolvedValueOnce({ id: CONVERSATION_ID, title: 'My name for it' })
        .mockResolvedValueOnce({ ...conversation, title: 'How do I connect GitHub?' });
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'POST',
        url,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({
        conversation: { title: 'How do I connect GitHub?', titleSource: 'FIRST_MESSAGE' },
        naming: true,
      });
      expect(prisma.assistantMessage.findFirst.mock.calls[0]?.[0]).toMatchObject({
        orderBy: { createdAt: 'asc' },
        where: { conversationId: CONVERSATION_ID, role: 'USER' },
      });
      expect(prisma.assistantConversation.updateMany).toHaveBeenCalledWith({
        data: { title: 'How do I connect GitHub?', titleSource: 'FIRST_MESSAGE' },
        where: { closedAt: null, id: CONVERSATION_ID, userId: USER_ID },
      });
      expect(temporal.nameAssistantConversation).toHaveBeenCalledWith({
        conversationId: CONVERSATION_ID,
        userId: USER_ID,
      });
    });

    it('resets without naming while the assistant or model titles are off', async () => {
      settings.resolveSetting.mockImplementation(
        async (key: string) => key !== 'assistant.generateTitles'
      );
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'POST',
        url,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.naming).toBe(false);
      expect(temporal.nameAssistantConversation).not.toHaveBeenCalled();
      expect(prisma.assistantConversation.updateMany).toHaveBeenCalledTimes(1);
    });

    it('keeps the reset when the naming cannot be started', async () => {
      temporal.nameAssistantConversation.mockRejectedValue(new Error('temporal down'));
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'POST',
        url,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.naming).toBe(false);
    });

    it("is not found for another user's or a closed conversation", async () => {
      prisma.assistantConversation.findFirst.mockResolvedValue(null);
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'POST',
        url,
      });
      expect(res.statusCode).toBe(404);
      expect(prisma.assistantConversation.updateMany).not.toHaveBeenCalled();
    });

    it('is refused to the assistant itself', async () => {
      const res = await app.inject({
        headers: { authorization: assistantBearer(app) },
        method: 'POST',
        url,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ASSISTANT_NOT_ALLOWED');
    });
  });

  describe('GET /conversations/:id/messages/:messageId/stream', () => {
    it('sends the finished reply and ends', async () => {
      prisma.assistantMessage.findFirst.mockResolvedValue(
        message({
          content: 'See [Integrations](/docs/configuration#integrations).',
          status: 'COMPLETE',
        })
      );
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'GET',
        url: `${PREFIX}/conversations/${CONVERSATION_ID}/messages/${REPLY_ID}/stream`,
      });
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.body).toContain('event: message');
      expect(res.body).toContain('/docs/configuration#integrations');
      expect(res.body).toContain('event: done');
      expect(prisma.assistantMessage.findFirst.mock.calls[0][0].where).toMatchObject({
        conversation: { userId: USER_ID },
        id: REPLY_ID,
      });
    });

    it('streams a reply as it grows', async () => {
      prisma.assistantMessage.findFirst
        .mockResolvedValueOnce(message({ status: 'STREAMING' }))
        .mockResolvedValueOnce(message({ content: 'Part', status: 'STREAMING' }))
        .mockResolvedValue(message({ content: 'Part and whole', status: 'COMPLETE' }));
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'GET',
        url: `${PREFIX}/conversations/${CONVERSATION_ID}/messages/${REPLY_ID}/stream`,
      });
      const events = res.body.split('\n\n').filter((e) => e.startsWith('event: message'));
      expect(events).toHaveLength(3);
      expect(res.body).toContain('"content":"Part and whole"');
    });
  });
});

describe('ApiCatalog', () => {
  it('lists only routes the assistant may call, with their schemas, reads first', () => {
    const catalog = new ApiCatalog();
    catalog.add({
      method: 'GET',
      schema: { querystring: z.object({ status: z.enum(['FAILED', 'SUCCESS']).optional() }) },
      url: '/api/v1/workflow-runs',
    });
    catalog.add({ method: 'POST', url: '/api/v1/agent-runs' });
    catalog.add({ method: 'GET', url: '/api/v1/auth/tokens' });
    catalog.add({ method: 'DELETE', url: '/api/v1/workflow-runs/:id' });
    catalog.add({ method: 'GET', url: '/health' });

    expect(catalog.size).toBe(2);
    const runs = catalog.search('runs failed', 5);
    expect(runs.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /api/v1/workflow-runs',
      'POST /api/v1/agent-runs',
    ]);
    expect(runs[0]?.access).toBe('read');
    expect(JSON.stringify(runs[0]?.query)).toContain('FAILED');
    expect(runs[1]?.access).toBe('confirm');
    expect(catalog.search('tokens', 5)).toEqual([]);
  });

  it('describes a route whose schema is plain JSON Schema', () => {
    const catalog = new ApiCatalog();
    catalog.add({
      method: 'GET',
      schema: { params: { properties: { id: { type: 'string' } }, type: 'object' } },
      url: '/api/v1/workflow-runs/:id',
    });
    expect(catalog.search('workflow-runs', 1)[0]?.params).toEqual({
      properties: { id: { type: 'string' } },
      type: 'object',
    });
  });

  it('is served to the assistant', async () => {
    settings.resolveSetting.mockReset().mockResolvedValue(true);
    const prisma = makePrisma();
    const catalog = new ApiCatalog();
    const app = await buildAssistantApp(prisma as never, async (a) => {
      a.addHook('onRoute', (route) => catalog.add(route));
      a.get('/api/v1/workflow-runs', { onRequest: requireAuth() }, async () => ({ data: [] }));
      await a.register(assistantConversationRoutes, { catalog, prefix: PREFIX });
    });
    const res = await app.inject({
      headers: { authorization: assistantBearer(app) },
      method: 'GET',
      url: `${PREFIX}/api-catalog?q=runs`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().routes.map((r: { path: string }) => r.path)).toContain(
      '/api/v1/workflow-runs'
    );
    await app.close();
  });
});
