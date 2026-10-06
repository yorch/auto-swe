import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lessonRoutes } from './lessons.js';

function newMockPrisma() {
  const prisma = {
    $transaction: vi.fn(),
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    connection: { findFirst: vi.fn() },
    memoryItem: {
      count: vi.fn().mockResolvedValue(0),
      delete: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
  return prisma;
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
  it('lists repository lessons only, never channel memory — even for an admin', async () => {
    const { app, prisma } = await buildApp('ADMIN');
    await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/lessons' });
    expect(lastListWhere(prisma)).toMatchObject({ scope: 'swe-lessons' });
  });

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

  it('narrows to one repository and a search term', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/lessons?repoId=${REPO_ID}&q=retry`,
    });
    expect(res.statusCode).toBe(200);
    const where = lastListWhere(prisma);
    expect(where.repoId).toBe(REPO_ID);
    expect(where.OR).toEqual([
      { lessonSummary: { contains: 'retry', mode: 'insensitive' } },
      { rationale: { contains: 'retry', mode: 'insensitive' } },
    ]);
  });

  it('rejects a repoId that is not a UUID', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/lessons?repoId=nope',
    });
    expect(res.statusCode).toBe(400);
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

describe('DELETE /lessons/:id', () => {
  const LESSON_ID = '22222222-2222-4222-8222-222222222222';

  it('only finds a lesson by id within the lesson scope', async () => {
    const { app, prisma } = await buildApp('ADMIN');
    const res = await app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/lessons/${LESSON_ID}`,
    });
    expect(res.statusCode).toBe(404);
    expect(prisma.memoryItem.findFirst.mock.calls[0][0].where).toEqual({
      id: LESSON_ID,
      scope: 'swe-lessons',
    });
    expect(prisma.memoryItem.delete).not.toHaveBeenCalled();
  });

  it('deletes and audits the deleted content in one transaction', async () => {
    const { app, prisma } = await buildApp('ADMIN');
    const lesson = { id: LESSON_ID, lessonSummary: 'run migrations first', rationale: 'r' };
    prisma.memoryItem.findFirst.mockResolvedValue(lesson);

    const res = await app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/lessons/${LESSON_ID}`,
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(prisma.memoryItem.delete).toHaveBeenCalledWith({ where: { id: LESSON_ID } });
    expect(prisma.configAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'DELETE',
        actorId: 'admin-1',
        beforeJson: lesson,
        entityId: LESSON_ID,
        entityType: 'MemoryItem',
      }),
    });
  });

  it('refuses a non-admin', async () => {
    const { app } = await buildApp('ENGINEER');
    const res = await app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/lessons/${LESSON_ID}`,
    });
    expect(res.statusCode).toBe(403);
  });
});
