import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  'analytics.activityRetentionDays': 90,
  'analytics.uiEventsEnabled': false,
}));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: keyof typeof settings) => settings[key]),
}));

import { type ActivityEventRow, ActivityQueue } from '../lib/activityEvents.js';
import { activityAdminRoutes, activityUiRoutes } from './activity.js';

const AUTH = { authorization: 'Bearer fake' };

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const written: ActivityEventRow[] = [];
  const queue = new ActivityQueue({
    write: async (rows) => {
      written.push(...rows);
    },
  });
  const prisma = {
    user: { findMany: vi.fn().mockResolvedValue([]) },
    userActivityEvent: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
  };
  app.decorate('prisma', prisma as never);
  app.decorate('activityQueue', queue);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
  } as never);
  await app.register(activityAdminRoutes, { prefix: '/api/v1/platform' });
  await app.register(activityUiRoutes, { prefix: '/api/v1/activity' });
  await app.ready();
  return { app, prisma, queue, written };
}

describe('POST /api/v1/activity/ui', () => {
  const post = (app: Awaited<ReturnType<typeof buildApp>>['app'], events: unknown) =>
    app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { events },
      url: '/api/v1/activity/ui',
    });

  it('accepts nothing, and says so, while the setting is off', async () => {
    settings['analytics.uiEventsEnabled'] = false;
    const { app, queue, written } = await buildApp('ENGINEER');
    const res = await post(app, [{ event: 'page_view', route: '/runs' }]);
    expect(res.json()).toEqual({ accepted: 0, enabled: false });
    await queue.flush();
    expect(written).toEqual([]);
  });

  it('stores route templates only, and drops what is not a known page', async () => {
    settings['analytics.uiEventsEnabled'] = true;
    const { app, queue, written } = await buildApp('ENGINEER');
    const res = await post(app, [
      { event: 'page_view', route: '/runs/5d2c0f1e-aaaa-bbbb-cccc-1234567890ab' },
      { event: 'page_view', route: '/runs?token=abc' },
      { event: 'page_view', route: '/not-a-page' },
      { event: 'page_view', route: '/admin/users' },
    ]);
    expect(res.json()).toEqual({ accepted: 2, enabled: true });
    await queue.flush();
    expect(written.map((r) => [r.kind, r.route, r.actorId])).toEqual([
      ['ui', '/runs/[id]', 'user-1'],
      ['ui', '/admin/users', 'user-1'],
    ]);
    expect(JSON.stringify(written)).not.toContain('5d2c0f1e');
  });

  it('collapses the same page repeated within a batch and across batches', async () => {
    settings['analytics.uiEventsEnabled'] = true;
    const { app, queue, written } = await buildApp('ENGINEER');
    const first = await post(app, [
      { event: 'page_view', route: '/runs/a' },
      { event: 'page_view', route: '/runs/b' },
      { event: 'page_view', route: '/runs' },
    ]);
    expect(first.json().accepted).toBe(2);
    const second = await post(app, [{ event: 'page_view', route: '/runs' }]);
    expect(second.json().accepted).toBe(0);
    await queue.flush();
    expect(written.map((r) => r.route)).toEqual(['/runs/[id]', '/runs']);
  });

  it('refuses an event kind it does not know and an empty batch', async () => {
    settings['analytics.uiEventsEnabled'] = true;
    const { app } = await buildApp('ENGINEER');
    expect((await post(app, [{ event: 'click', route: '/runs' }])).statusCode).toBe(400);
    expect((await post(app, [])).statusCode).toBe(400);
  });
});

describe('GET /api/v1/platform/activity', () => {
  it('is ADMIN-only', async () => {
    const { app } = await buildApp('ENGINEER');
    for (const url of ['/api/v1/platform/activity', '/api/v1/platform/activity/summary']) {
      expect((await app.inject({ headers: AUTH, url })).statusCode).toBe(403);
    }
  });

  it('filters by kind and day and names the actor', async () => {
    const { app, prisma } = await buildApp('ADMIN');
    prisma.userActivityEvent.findMany.mockResolvedValueOnce([
      {
        actorId: '11111111-1111-4111-8111-111111111111',
        createdAt: new Date('2026-10-01T10:00:00.000Z'),
        id: 'e1',
        ip: '198.51.100.0',
        kind: 'denied',
        method: 'GET',
        props: null,
        requestId: 'r1',
        route: '/api/v1/platform/audit-log',
        status: 403,
        via: 'jwt',
      },
    ]);
    prisma.user.findMany.mockResolvedValueOnce([
      { email: 'alice@example.com', id: '11111111-1111-4111-8111-111111111111', name: 'Alice' },
    ]);
    const res = await app.inject({
      headers: AUTH,
      url: '/api/v1/platform/activity?kind=denied&since=2026-10-01&until=2026-10-02',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0]).toMatchObject({
      actor: { email: 'alice@example.com' },
      kind: 'denied',
      route: '/api/v1/platform/audit-log',
    });
    expect(prisma.userActivityEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          createdAt: {
            gte: new Date('2026-10-01T00:00:00.000Z'),
            lt: new Date('2026-10-03T00:00:00.000Z'),
          },
          kind: 'denied',
        },
      })
    );
  });

  it('summarizes counts by kind and day, top denied routes and the drop counter', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
    try {
      const { app, prisma, queue } = await buildApp('ADMIN');
      queue.dropped = 4;
      prisma.userActivityEvent.groupBy.mockImplementation(
        async (args: { by: string[]; where: { createdAt: { gte: Date } } }) => {
          if (args.by[0] === 'route') {
            return [{ _count: { _all: 2 }, route: '/api/v1/platform/audit-log' }];
          }
          const day = args.where.createdAt.gte.toISOString().slice(0, 10);
          return day === '2026-10-01'
            ? [
                { _count: { _all: 1 }, kind: 'denied' },
                { _count: { _all: 1 }, kind: 'read' },
              ]
            : [{ _count: { _all: 1 }, kind: 'denied' }];
        }
      );
      const res = await app.inject({
        headers: AUTH,
        url: '/api/v1/platform/activity/summary?days=2',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        daily: [
          { day: '2026-10-01', denied: 1, export: 0, read: 1, ui: 0 },
          { day: '2026-10-02', denied: 1, export: 0, read: 0, ui: 0 },
        ],
        dropped: 4,
        retentionDays: 90,
        topDenied: [{ count: 2, route: '/api/v1/platform/audit-log' }],
        totals: { denied: 2, export: 0, read: 1, ui: 0 },
      });
      // It counts in the database: no row is read back.
      expect(prisma.userActivityEvent.findMany).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never runs more than three day-counts at once', async () => {
    const { app, prisma } = await buildApp('ADMIN');
    let inFlight = 0;
    let peak = 0;
    prisma.userActivityEvent.groupBy.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return [];
    });
    const res = await app.inject({
      headers: AUTH,
      url: '/api/v1/platform/activity/summary?days=30',
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.userActivityEvent.groupBy).toHaveBeenCalledTimes(31);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('refuses a window longer than 30 days', async () => {
    const { app } = await buildApp('ADMIN');
    const res = await app.inject({
      headers: AUTH,
      url: '/api/v1/platform/activity/summary?days=31',
    });
    expect(res.statusCode).toBe(400);
  });
});
