import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assistantDiagnosticsRoutes } from './assistantDiagnostics.js';

const CONVERSATION = '11111111-1111-4111-8111-111111111111';
const MESSAGE = '22222222-2222-4222-8222-222222222222';
const CREATED = new Date('2026-10-14T10:00:00Z');
const FAILED = new Date('2026-10-14T10:01:00Z');

function failureRow(over: Record<string, unknown> = {}) {
  return {
    conversation: { user: { email: 'ada@example.com', id: 'user-1', name: 'Ada' } },
    conversationId: CONVERSATION,
    createdAt: CREATED,
    error: 'I hit an error answering that. Please try again.',
    errorDetail: 'APICallError: Invalid model',
    id: MESSAGE,
    updatedAt: FAILED,
    ...over,
  };
}

function newMockPrisma() {
  return {
    agentTrace: { findMany: vi.fn().mockResolvedValue([]) },
    assistantMessage: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

async function buildApp(role: 'ADMIN' | 'LEAD' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = newMockPrisma();
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'admin-1' }),
  } as unknown as never);
  await app.register(assistantDiagnosticsRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  return { app, prisma };
}

const AUTH = { authorization: 'Bearer fake' };

beforeEach(() => vi.clearAllMocks());

describe('assistantDiagnosticsRoutes', () => {
  it('refuses anyone but an admin', async () => {
    const { app } = await buildApp('LEAD');
    for (const url of [
      '/api/v1/platform/assistant/failures',
      `/api/v1/platform/assistant/failures/${MESSAGE}`,
    ]) {
      const res = await app.inject({ headers: AUTH, method: 'GET', url });
      expect(res.statusCode).toBe(403);
    }
  });

  it('lists failed replies across users in the window, with their cause', async () => {
    const { app, prisma } = await buildApp();
    prisma.assistantMessage.findMany.mockResolvedValue([failureRow()]);
    prisma.assistantMessage.count.mockResolvedValue(1);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/assistant/failures?since=2026-10-01T00:00:00Z&limit=10',
    });
    expect(res.statusCode).toBe(200);
    const where = prisma.assistantMessage.findMany.mock.calls[0]?.[0].where;
    expect(where).toEqual({
      createdAt: { gte: new Date('2026-10-01T00:00:00Z') },
      role: 'ASSISTANT',
      status: 'FAILED',
    });
    expect(res.json()).toEqual({
      data: [
        {
          conversationId: CONVERSATION,
          createdAt: CREATED.toISOString(),
          error: 'I hit an error answering that. Please try again.',
          errorDetail: 'APICallError: Invalid model',
          failedAt: FAILED.toISOString(),
          id: MESSAGE,
          user: { email: 'ada@example.com', id: 'user-1', name: 'Ada' },
          workflowId: `assistant-${CONVERSATION}`,
        },
      ],
      meta: { limit: 10, offset: 0, total: 1 },
    });
  });

  it('never selects message text or the conversation title', async () => {
    const { app, prisma } = await buildApp();
    await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/platform/assistant/failures' });
    const select = prisma.assistantMessage.findMany.mock.calls[0]?.[0].select;
    expect(select).not.toHaveProperty('content');
    expect(select.conversation.select).not.toHaveProperty('title');
  });

  it('answers 404 for a reply that is not a failure', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/platform/assistant/failures/${MESSAGE}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("reads the turn's own trace rows, without their payloads", async () => {
    const { app, prisma } = await buildApp();
    // The reply waited behind an earlier turn that finished after it was created.
    const earlierDone = new Date('2026-10-14T10:00:20Z');
    prisma.assistantMessage.findFirst
      .mockResolvedValueOnce(failureRow())
      .mockResolvedValueOnce({ updatedAt: earlierDone });
    prisma.agentTrace.findMany.mockResolvedValue([
      {
        agentKey: 'appAssistant',
        attempt: 1,
        costUsd: null,
        createdAt: new Date('2026-10-14T10:00:59Z'),
        durationMs: 812,
        error: 'Invalid model: anthropic/claude-nope',
        id: 't1',
        inputTokens: null,
        model: 'anthropic/claude-nope',
        otelTraceId: 'abc',
        outputTokens: null,
        toolName: null,
        type: 'llm_response',
      },
    ]);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/platform/assistant/failures/${MESSAGE}`,
    });
    expect(res.statusCode).toBe(200);
    const query = prisma.agentTrace.findMany.mock.calls[0]?.[0];
    // Rows tagged with this reply, plus untagged rows from before the tag existed, which are
    // found by the conversation's workflow and the turn's time window.
    expect(query.where).toEqual({
      OR: [
        { assistantMessageId: MESSAGE },
        {
          assistantMessageId: null,
          createdAt: { gte: earlierDone, lte: FAILED },
          workflowId: `assistant-${CONVERSATION}`,
        },
      ],
    });
    expect(query.select).not.toHaveProperty('inputJson');
    expect(query.select).not.toHaveProperty('outputJson');
    const body = res.json().data;
    expect(body.errorDetail).toBe('APICallError: Invalid model');
    expect(body.traces).toEqual([
      expect.objectContaining({
        createdAt: '2026-10-14T10:00:59.000Z',
        error: 'Invalid model: anthropic/claude-nope',
        model: 'anthropic/claude-nope',
      }),
    ]);
  });

  it('starts the trace window at the reply when no earlier turn overlaps it', async () => {
    const { app, prisma } = await buildApp();
    prisma.assistantMessage.findFirst
      .mockResolvedValueOnce(failureRow())
      .mockResolvedValueOnce({ updatedAt: new Date('2026-10-14T09:00:00Z') });
    await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/platform/assistant/failures/${MESSAGE}`,
    });
    expect(prisma.agentTrace.findMany.mock.calls[0]?.[0].where.OR[1].createdAt).toEqual({
      gte: CREATED,
      lte: FAILED,
    });
  });
});
