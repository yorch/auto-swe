import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lessonRoutes } from './lessons.js';

function newMockPrisma() {
  return {
    connection: { findFirst: vi.fn() },
    memoryItem: {
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
  await app.register(lessonRoutes, { prefix: '/api/v1/lessons' });
  await app.ready();
  return { app, prisma };
}

const AUTH = { authorization: 'Bearer fake' };
const REPO_ID = '11111111-1111-4111-8111-111111111111';

function lastListWhere(prisma: ReturnType<typeof newMockPrisma>) {
  return prisma.memoryItem.findMany.mock.calls[0][0].where as Record<string, unknown>;
}

beforeEach(() => vi.clearAllMocks());

describe('GET /lessons (list)', () => {
  it('excludes consolidated lessons by default', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/lessons' });
    expect(res.statusCode).toBe(200);
    expect(lastListWhere(prisma).consolidatedAt).toBeNull();
  });

  // Regression: z.coerce.boolean() treats the *string* "false" as truthy
  // (Boolean("false") === true), so ?includeConsolidated=false used to
  // silently include consolidated (soft-deleted) lessons.
  it('excludes consolidated lessons when includeConsolidated=false is explicit', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/lessons?includeConsolidated=false',
    });
    expect(res.statusCode).toBe(200);
    expect(lastListWhere(prisma).consolidatedAt).toBeNull();
  });

  it('includes consolidated lessons when includeConsolidated=true', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/lessons?includeConsolidated=true',
    });
    expect(res.statusCode).toBe(200);
    expect(lastListWhere(prisma).consolidatedAt).toBeUndefined();
  });

  it('rejects an includeConsolidated value other than true/false', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/lessons?includeConsolidated=0',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /lessons/search', () => {
  function lastSearchWhere(prisma: ReturnType<typeof newMockPrisma>) {
    return prisma.memoryItem.findMany.mock.calls[0][0].where as Record<string, unknown>;
  }

  it('excludes consolidated lessons when includeConsolidated=false is explicit', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/lessons/search?q=foo&repoId=${REPO_ID}&includeConsolidated=false`,
    });
    expect(res.statusCode).toBe(200);
    expect(lastSearchWhere(prisma).consolidatedAt).toBeNull();
  });

  it('includes consolidated lessons when includeConsolidated=true', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/lessons/search?q=foo&repoId=${REPO_ID}&includeConsolidated=true`,
    });
    expect(res.statusCode).toBe(200);
    expect(lastSearchWhere(prisma).consolidatedAt).toBeUndefined();
  });
});
