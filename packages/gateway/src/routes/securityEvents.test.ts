import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { securityEventRoutes } from './securityEvents.js';

function newMockPrisma() {
  return {
    agentTrace: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = newMockPrisma();
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'admin-1' }),
  } as unknown as never);
  await app.register(securityEventRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  return { app, prisma };
}

const AUTH = { authorization: 'Bearer fake' };

function traceRow(over: Record<string, unknown>) {
  return {
    createdAt: new Date('2026-06-24T00:00:00Z'),
    error: null,
    id: 't1',
    inputJson: {},
    nodeId: 'n1',
    outputJson: {},
    run: { startedAt: new Date('2026-06-24T00:00:00Z'), workflowId: 'wf', workRequest: null },
    runId: 'r1',
    toolName: null,
    type: 'activity_event',
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('securityEventRoutes', () => {
  it('rejects non-admins', async () => {
    const { app } = await buildApp('ENGINEER');
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/security-events',
    });
    expect(res.statusCode).toBe(403);
  });

  it('pushes the CHANNEL_SUSPICIOUS predicate into the DB query', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/security-events?type=CHANNEL_SUSPICIOUS',
    });
    expect(res.statusCode).toBe(200);
    const where = prisma.agentTrace.findMany.mock.calls[0][0].where as {
      OR: object[];
    };
    // Only the one CHANNEL_SUSPICIOUS predicate when the type filter is set.
    expect(where.OR).toEqual([
      { AND: [{ type: 'activity_event' }, { toolName: 'channel.suspicious_input' }] },
    ]);
  });

  it('includes the channel predicate in the unfiltered OR set', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/security-events',
    });
    expect(res.statusCode).toBe(200);
    const where = prisma.agentTrace.findMany.mock.calls[0][0].where as {
      OR: object[];
    };
    expect(where.OR).toContainEqual({
      AND: [{ type: 'activity_event' }, { toolName: 'channel.suspicious_input' }],
    });
  });

  it('classifies a channel.suspicious_input trace as CHANNEL_SUSPICIOUS', async () => {
    const { app, prisma } = await buildApp();
    prisma.agentTrace.findMany.mockResolvedValue([
      traceRow({ toolName: 'channel.suspicious_input', type: 'activity_event' }),
    ]);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/security-events',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data[0].eventType).toBe('CHANNEL_SUSPICIOUS');
  });
});
