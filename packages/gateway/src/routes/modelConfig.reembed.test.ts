import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');

import { modelConfigRoutes } from './modelConfig.js';

const SPEC = 'openai/text-embedding-3-large';

function newMocks() {
  return {
    prisma: {
      configAuditLog: { create: vi.fn().mockResolvedValue({}) },
      embeddingConfig: { findUnique: vi.fn().mockResolvedValue({ modelSpec: SPEC }) },
      memoryItem: {
        // First call counts every row, second the stale ones.
        count: vi.fn().mockResolvedValueOnce(120).mockResolvedValueOnce(30),
      },
    },
    temporal: {
      isReembedStaleMemoryRunning: vi.fn().mockResolvedValue(false),
      startReembedStaleMemory: vi.fn().mockResolvedValue(true),
    },
  };
}

async function build(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const mocks = newMocks();
  app.decorate('prisma', mocks.prisma as unknown as never);
  app.decorate('temporal', mocks.temporal as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'admin-1' }),
  } as unknown as never);
  await app.register(modelConfigRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  return { app, ...mocks };
}

const AUTH = { authorization: 'Bearer fake' };
const URL = '/api/v1/platform/embedding-config/reembed';

beforeEach(() => vi.clearAllMocks());

describe('GET /embedding-config/reembed', () => {
  it('reports how many rows the configured model did not embed', async () => {
    const { app, prisma } = await build();
    const res = await app.inject({ headers: AUTH, method: 'GET', url: URL });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ modelSpec: SPEC, running: false, stale: 30, total: 120 });
    expect(prisma.memoryItem.count).toHaveBeenLastCalledWith({
      where: { OR: [{ embeddingModel: null }, { embeddingModel: { not: SPEC } }] },
    });
  });

  it('is admin-only', async () => {
    const { app } = await build('ENGINEER');
    const res = await app.inject({ headers: AUTH, method: 'GET', url: URL });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /embedding-config/reembed', () => {
  it('starts the bulk re-embed and audits who started it', async () => {
    const { app, prisma, temporal } = await build();
    const res = await app.inject({ headers: AUTH, method: 'POST', url: URL });

    expect(res.statusCode).toBe(202);
    expect(res.json().data).toEqual({ staleRows: 30, started: true });
    expect(temporal.startReembedStaleMemory).toHaveBeenCalledOnce();
    expect(prisma.configAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'admin-1',
        afterJson: { reembedStarted: true, staleRows: 30 },
        entityType: 'EmbeddingConfig',
      }),
    });
  });

  it('refuses a second walk while one runs', async () => {
    const { app, prisma, temporal } = await build();
    temporal.startReembedStaleMemory.mockResolvedValue(false);

    const res = await app.inject({ headers: AUTH, method: 'POST', url: URL });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('REEMBED_IN_PROGRESS');
    expect(prisma.configAuditLog.create).not.toHaveBeenCalled();
  });

  it('refuses when no embedding model is configured', async () => {
    const { app, prisma, temporal } = await build();
    prisma.embeddingConfig.findUnique.mockResolvedValue(null);

    const res = await app.inject({ headers: AUTH, method: 'POST', url: URL });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NO_EMBEDDING_CONFIG');
    expect(temporal.startReembedStaleMemory).not.toHaveBeenCalled();
  });
});
