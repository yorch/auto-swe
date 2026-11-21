import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: string) =>
    key === 'analytics.failedSignInAlertThreshold' ? 3 : 10
  ),
}));

import { userAnalyticsAlertsRoutes } from './userAnalyticsAlerts.js';

const AUTH = { authorization: 'Bearer fake' };
const t = (m: number) => new Date(Date.now() - m * 60_000);

async function build(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const app = Fastify();
  const groupBy = vi.fn().mockImplementation(async (args: { where: { kind: string } }) =>
    args.where.kind === 'sign_in_failed'
      ? [
          {
            _count: { _all: 7 },
            _max: { createdAt: t(1) },
            _min: { createdAt: t(9) },
            actorId: 'u1',
          },
          {
            _count: { _all: 3 },
            _max: { createdAt: t(2) },
            _min: { createdAt: t(8) },
            actorId: 'u2',
          },
        ]
      : [{ _max: { createdAt: t(3) }, actorId: 'u1' }]
  );
  const prisma = {
    user: {
      findMany: vi.fn().mockResolvedValue([{ email: 'a@x.io', id: 'u1', name: 'Ada' }]),
    },
    userActivityEvent: {
      findMany: vi.fn().mockResolvedValue([
        { actorId: 'u1', props: { method: 'password' } },
        { actorId: 'u1', props: { method: 'github' } },
      ]),
      groupBy,
    },
  };
  app.decorate('prisma', prisma as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'admin-1' }),
  } as never);
  await app.register(userAnalyticsAlertsRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  return { app, groupBy };
}

describe('GET /api/v1/platform/analytics/alerts', () => {
  it('lists accounts over the threshold, worst first, flagging a later success', async () => {
    const { app, groupBy } = await build();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/analytics/alerts',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.threshold).toBe(3);
    expect(body.windowMinutes).toBe(10);
    expect(body).toMatchObject({
      failuresRecordedPerMinute: 30,
      maxRecordable: 330,
      thresholdReachable: true,
    });
    expect(body.truncated).toBe(false);
    expect(body.alerts.map((a: { userId: string }) => a.userId)).toEqual(['u1', 'u2']);
    expect(body.alerts[0]).toMatchObject({
      email: 'a@x.io',
      failures: 7,
      methods: ['github', 'password'],
      signedInAfter: true,
    });
    expect(body.alerts[1]).toMatchObject({ email: null, signedInAfter: false });
    const first = groupBy.mock.calls[0]?.[0];
    expect(first.take).toBe(51);
    expect(first.having).toEqual({ actorId: { _count: { gte: 3 } } });
  });

  it('is refused for a non-admin', async () => {
    const { app } = await build('ENGINEER');
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/analytics/alerts',
    });
    expect(res.statusCode).toBe(403);
  });
});
