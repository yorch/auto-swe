import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { orgBudgetRoutes } from './orgBudget.js';

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';

const ORG_ROW = {
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
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('prisma', {
    organization: {
      findUnique: vi.fn().mockResolvedValue(ORG_ROW),
      update: vi.fn().mockResolvedValue({ ...ORG_ROW, monthlyBudgetUsdCents: 5000 }),
    },
    organizationMembership: {
      findUnique: vi.fn().mockResolvedValue(membershipRole ? { role: membershipRole } : null),
    },
    orgMonthlyUsage: {
      findUnique: vi.fn().mockResolvedValue(USAGE_ROW),
    },
  } as unknown as never);

  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: USER_ID }),
  } as unknown as never);

  app.addHook('onRequest', async (req) => {
    req.headers.authorization = 'Bearer fake-token';
  });

  app.register(orgBudgetRoutes);
  return app;
}

describe('GET /:orgId/budget', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns budget + usage for org member', async () => {
    const app = buildApp('LEAD');
    await app.ready();
    const res = await app.inject({ method: 'GET', url: `/${ORG_ID}/budget` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.monthlyBudgetUsdCents).toBe(10000);
    expect(body.currentMonthUsage).not.toBeNull();
    expect(body.currentMonthUsage.runsCompleted).toBe(5);
  });

  it('returns 403 for non-member', async () => {
    const app = buildApp('LEAD', null);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: `/${ORG_ID}/budget` });
    expect(res.statusCode).toBe(403);
  });
});

describe('PATCH /:orgId/budget', () => {
  afterEach(() => vi.clearAllMocks());

  it('updates the monthly budget cap', async () => {
    const app = buildApp('ADMIN');
    await app.ready();
    const res = await app.inject({
      body: JSON.stringify({ monthlyBudgetUsdCents: 5000 }),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
      url: `/${ORG_ID}/budget`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.monthlyBudgetUsdCents).toBe(5000);
  });

  it('accepts null to remove the cap', async () => {
    const app = buildApp('ADMIN');
    await app.ready();
    const res = await app.inject({
      body: JSON.stringify({ monthlyBudgetUsdCents: null }),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
      url: `/${ORG_ID}/budget`,
    });
    expect(res.statusCode).toBe(200);
  });
});
