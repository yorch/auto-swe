import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import { userAnalyticsRoutes } from './userAnalytics.js';

const AUTH = { authorization: 'Bearer fake' };
const UID = '11111111-1111-4111-8111-111111111111';
const today = new Date();
today.setUTCHours(10, 0, 0, 0);

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const user = {
    createdAt: new Date('2026-01-01T00:00:00Z'),
    email: 'a@example.com',
    id: UID,
    name: 'Ada',
    role: 'USER',
  };
  const prisma = {
    configAuditLog: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockImplementation(async (args: { by: string[] }) =>
        args.by.includes('entityType') && args.by.includes('actorId')
          ? [
              {
                _count: { _all: 3 },
                _max: { createdAt: today },
                action: 'CREATE',
                actorId: UID,
                entityType: 'Repo',
              },
            ]
          : []
      ),
    },
    session: {
      count: vi.fn().mockResolvedValue(2),
      findMany: vi.fn().mockResolvedValue([
        {
          createdAt: today,
          expiresAt: today,
          id: 's1',
          ipAddress: '203.0.113.77',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36',
        },
      ]),
      groupBy: vi.fn().mockResolvedValue([{ _count: { _all: 1 }, userId: UID }]),
    },
    user: {
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue([user]),
      findUnique: vi
        .fn()
        .mockImplementation(async ({ where }: { where: { id: string } }) =>
          where.id === UID
            ? { ...user, memberships: [{ role: 'LEAD', team: { id: 't1', slug: 'pay' } }] }
            : null
        ),
    },
    userActivityEvent: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockImplementation(async (args: { by: string[] }) =>
        args.by.includes('actorId') && args.by.includes('kind')
          ? [
              {
                _count: { _all: 2 },
                _max: { createdAt: today },
                actorId: UID,
                kind: 'sign_in',
              },
            ]
          : []
      ),
    },
  };
  app.decorate('prisma', prisma as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'admin-1' }),
  } as never);
  await app.register(userAnalyticsRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  return { app, prisma };
}

describe('GET /api/v1/platform/analytics/overview', () => {
  it('is ADMIN only', async () => {
    const { app } = await buildApp('ENGINEER');
    const res = await app.inject({ headers: AUTH, url: '/api/v1/platform/analytics/overview' });
    expect(res.statusCode).toBe(403);
  });

  it('returns a zero-filled series and the active-user counts', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      url: '/api/v1/platform/analytics/overview?days=7',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.activeByDay).toHaveLength(7);
    expect(body.users).toMatchObject({ dau: 1, mau: 1, stickinessPct: 100, total: 1, wau: 1 });
    expect(body.signIns.total).toBe(14);
    expect(body.actions.byAction.CREATE).toBe(21);
    expect(body.actions.byEntityType[0]).toEqual({ count: 21, entityType: 'Repo' });
    expect(body.activeSessions).toBe(2);
    expect(body.peakHours).toHaveLength(24);
    // 30 days x two sources, then served from the cache.
    expect(prisma.userActivityEvent.groupBy).toHaveBeenCalledTimes(30);
    await app.inject({ headers: AUTH, url: '/api/v1/platform/analytics/overview?days=7' });
    expect(prisma.userActivityEvent.groupBy).toHaveBeenCalledTimes(30);
  });

  it('breaks sign-ins down by successful attempts only', async () => {
    const { app, prisma } = await buildApp();
    const at = new Date();
    prisma.userActivityEvent.findMany.mockResolvedValue([
      {
        createdAt: at,
        kind: 'sign_in',
        props: { browser: 'Chrome', method: 'github', os: 'macOS' },
      },
      {
        createdAt: at,
        kind: 'sign_in_failed',
        props: { browser: 'Other', method: 'password', os: 'Linux' },
      },
      {
        createdAt: at,
        kind: 'sign_in_failed',
        props: { browser: 'Other', method: 'password', os: 'Linux' },
      },
    ]);
    const res = await app.inject({
      headers: AUTH,
      url: '/api/v1/platform/analytics/overview?days=7',
    });
    expect(res.json().signIns.byMethod).toEqual([{ count: 1, method: 'github' }]);
    expect(res.json().signIns.byBrowser).toEqual([{ count: 1, name: 'Chrome' }]);
  });

  it('rejects a window over 30 days', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      url: '/api/v1/platform/analytics/overview?days=90',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/v1/platform/analytics/users', () => {
  it('lists people with window aggregates', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      url: '/api/v1/platform/analytics/users?days=7&q=ada&sort=actions',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta).toMatchObject({ days: 7, limit: 25, offset: 0, total: 1, truncated: false });
    expect(body.data[0]).toMatchObject({
      actions: 21,
      activeDays: 7,
      activeSessions: 1,
      email: 'a@example.com',
      signIns: 14,
      userId: UID,
    });
  });
});

describe('GET /api/v1/platform/analytics/users/:id', () => {
  it('404s for an unknown user', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      url: '/api/v1/platform/analytics/users/22222222-2222-4222-8222-222222222222',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns the profile, never a token or raw user agent, and is tagged as a read', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      url: `/api/v1/platform/analytics/users/${UID}?days=7`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.teams).toEqual([{ id: 't1', role: 'LEAD', slug: 'pay' }]);
    expect(body.daily).toHaveLength(7);
    expect(body.sessions[0]).toMatchObject({
      browser: 'Chrome',
      ipTruncated: '203.0.113.0',
      os: 'Windows',
    });
    expect(JSON.stringify(body)).not.toMatch(/Mozilla|token|beforeJson|afterJson/);
  });
});
