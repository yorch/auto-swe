import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeAuthedApp } from '../test/authedApp.js';
import { orgBudgetRoutes } from './orgBudget.js';

// Org spend comes from the mock's `orgMonthlyUsage` row (see test/billingMock.ts).
vi.mock('@auto-swe/shared/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../test/billingMock.js')),
}));

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const PREFIX = '/api/v1/admin/organizations';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';

const ORG_ROW = {
  budgetAlertThresholdPercent: 80,
  id: ORG_ID,
  monthlyBudgetUsdCents: 10000,
  name: 'Test Org',
};

const USAGE_ROW = {
  costUsdAccrued: '12.345',
  runsCompleted: 5,
  tokensInput: BigInt(1_000_000),
  tokensOutput: BigInt(500_000),
  yearMonth: '2026-06',
};

function buildApp(role: string, membershipRole: string | null = 'ORG_MEMBER') {
  const app = makeAuthedApp({
    prisma: {
      organization: {
        findMany: vi.fn().mockResolvedValue([ORG_ROW]),
        findUnique: vi.fn().mockResolvedValue(ORG_ROW),
        update: vi.fn().mockResolvedValue({ ...ORG_ROW, monthlyBudgetUsdCents: 5000 }),
      },
      organizationMembership: {
        findUnique: vi.fn().mockResolvedValue(membershipRole ? { role: membershipRole } : null),
      },
      orgMonthlyUsage: {
        findUnique: vi.fn().mockResolvedValue(USAGE_ROW),
      },
    },
    role,
    sub: USER_ID,
  });
  // Register under the real prefix so a plugin that drops it is caught here.
  app.register(orgBudgetRoutes, { prefix: PREFIX });
  return app;
}

describe('GET /:orgId/budget', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns budget + usage for an ORG_ADMIN', async () => {
    const app = buildApp('LEAD', 'ORG_ADMIN');
    await app.ready();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/${ORG_ID}/budget` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.monthlyBudgetUsdCents).toBe(10000);
    expect(body.budgetAlertThresholdPercent).toBe(80);
    expect(body.currentMonthUsage).not.toBeNull();
    expect(body.currentMonthUsage.runsCompleted).toBe(5);
    // The spend the cap is compared against, with its parts.
    expect(body.currentMonthSpend).toEqual({
      finalizedUsd: 12.345,
      inFlightUsd: 0,
      runlessUsd: 0,
      totalUsd: 12.345,
    });
  });

  it('returns 403 for non-member', async () => {
    const app = buildApp('LEAD', null);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/${ORG_ID}/budget` });
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 for a plain ORG_MEMBER: the dollar figures are the admin's", async () => {
    const app = buildApp('LEAD', 'ORG_MEMBER');
    await app.ready();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/${ORG_ID}/budget` });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('10000');
  });

  it('lets a platform ADMIN read it', async () => {
    const app = buildApp('ADMIN', null);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/${ORG_ID}/budget` });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /:orgId/budget/status', () => {
  afterEach(() => vi.clearAllMocks());

  it('gives an ORG_MEMBER the state and the percentage, with no dollar field', async () => {
    const app = buildApp('ENGINEER', 'ORG_MEMBER');
    await app.ready();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/${ORG_ID}/budget/status` });
    expect(res.statusCode).toBe(200);
    const { data } = JSON.parse(res.body);
    // $12.345 of a $100 cap.
    expect(data).toEqual({
      alertThresholdPercent: 80,
      percentUsed: 12.4,
      scope: 'org',
      state: expect.stringMatching(/^(ok|alert|projected_over)$/),
    });
    expect(res.body).not.toMatch(/usd|cents|12\.345|10000/i);
  });

  it('reports no_cap when the org has none', async () => {
    const app = buildApp('ENGINEER', 'ORG_MEMBER');
    (app.prisma.organization.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...ORG_ROW,
      monthlyBudgetUsdCents: null,
    });
    (app.prisma.organization as unknown as { findMany: unknown }).findMany = vi
      .fn()
      .mockResolvedValue([{ ...ORG_ROW, monthlyBudgetUsdCents: null }]);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/${ORG_ID}/budget/status` });
    expect(JSON.parse(res.body).data).toMatchObject({ percentUsed: null, state: 'no_cap' });
  });

  it('reports over when the spend has reached the cap', async () => {
    const app = buildApp('ENGINEER', 'ORG_MEMBER');
    (app.prisma.orgMonthlyUsage.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      costUsdAccrued: '120',
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/${ORG_ID}/budget/status` });
    expect(JSON.parse(res.body).data).toMatchObject({ percentUsed: 120, state: 'over' });
  });

  it('refuses someone outside the organization', async () => {
    const app = buildApp('ENGINEER', null);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/${ORG_ID}/budget/status` });
    expect(res.statusCode).toBe(403);
  });

  it('is also mounted under the platform prefix', async () => {
    const app = buildApp('ADMIN', null);
    app.register(orgBudgetRoutes, { prefix: '/api/v1/platform/organizations' });
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/platform/organizations/${ORG_ID}/budget/status`,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('PATCH /:orgId/budget', () => {
  afterEach(() => vi.clearAllMocks());

  it('updates the monthly budget cap', async () => {
    const app = buildApp('ADMIN');
    await app.ready();
    const res = await app.inject({
      body: JSON.stringify({ budgetAlertThresholdPercent: null, monthlyBudgetUsdCents: 5000 }),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
      url: `${PREFIX}/${ORG_ID}/budget`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.monthlyBudgetUsdCents).toBe(5000);
  });

  it('accepts null to remove the cap', async () => {
    const app = buildApp('ADMIN');
    await app.ready();
    const res = await app.inject({
      body: JSON.stringify({ budgetAlertThresholdPercent: null, monthlyBudgetUsdCents: null }),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
      url: `${PREFIX}/${ORG_ID}/budget`,
    });
    expect(res.statusCode).toBe(200);
  });

  it('400s, without writing, on a cap larger than the integer column holds', async () => {
    const app = buildApp('ADMIN');
    await app.ready();
    const res = await app.inject({
      body: JSON.stringify({ budgetAlertThresholdPercent: null, monthlyBudgetUsdCents: 2 ** 31 }),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
      url: `${PREFIX}/${ORG_ID}/budget`,
    });
    expect(res.statusCode).toBe(400);
    expect(app.prisma.organization.update).not.toHaveBeenCalled();
  });

  it('allows a platform-ENGINEER who is ORG_ADMIN to edit the cap', async () => {
    const app = buildApp('ENGINEER', 'ORG_ADMIN');
    await app.ready();
    const res = await app.inject({
      body: JSON.stringify({ budgetAlertThresholdPercent: null, monthlyBudgetUsdCents: 5000 }),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
      url: `${PREFIX}/${ORG_ID}/budget`,
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 403 for a platform-ENGINEER who is only an ORG_MEMBER', async () => {
    const app = buildApp('ENGINEER', 'ORG_MEMBER');
    await app.ready();
    const res = await app.inject({
      body: JSON.stringify({ budgetAlertThresholdPercent: null, monthlyBudgetUsdCents: 5000 }),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
      url: `${PREFIX}/${ORG_ID}/budget`,
    });
    expect(res.statusCode).toBe(403);
  });

  it('updates the budget alert threshold', async () => {
    const app = buildApp('ADMIN');
    await app.ready();
    const res = await app.inject({
      body: JSON.stringify({ budgetAlertThresholdPercent: 90, monthlyBudgetUsdCents: 10000 }),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
      url: `${PREFIX}/${ORG_ID}/budget`,
    });
    expect(res.statusCode).toBe(200);
    const update = app.prisma.organization.update as ReturnType<typeof vi.fn>;
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ budgetAlertThresholdPercent: 90 }),
      })
    );
  });
});
