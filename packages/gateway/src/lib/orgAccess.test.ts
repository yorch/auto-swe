import { describe, expect, it, vi } from 'vitest';

const spend = vi.hoisted(() => ({ orgMonthSpend: vi.fn() }));
vi.mock('@auto-swe/shared/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  orgMonthSpend: spend.orgMonthSpend,
}));

import {
  assertOrgAccess,
  assertOrgBudget,
  currentYearMonth,
  isOrgOverBudget,
} from './orgAccess.js';

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';

function makePrisma(membership: { role: string } | null) {
  return {
    organizationMembership: {
      findUnique: vi.fn().mockResolvedValue(membership),
    },
  };
}

function makeReply() {
  const reply = { send: vi.fn().mockResolvedValue(undefined), status: vi.fn().mockReturnThis() };
  return reply as unknown as import('fastify').FastifyReply;
}

const ADMIN_USER = { role: 'ADMIN', sub: USER_ID } as import('../plugins/auth.js').JwtPayload;
const LEAD_USER = { role: 'LEAD', sub: USER_ID } as import('../plugins/auth.js').JwtPayload;

describe('assertOrgAccess', () => {
  it('platform ADMIN always passes without DB query', async () => {
    const prisma = makePrisma(null);
    const reply = makeReply();
    const result = await assertOrgAccess(prisma as never, ADMIN_USER, ORG_ID, reply);
    expect(result).toBe(true);
    expect(prisma.organizationMembership.findUnique).not.toHaveBeenCalled();
  });

  it('returns true for org member', async () => {
    const prisma = makePrisma({ role: 'ORG_MEMBER' });
    const reply = makeReply();
    const result = await assertOrgAccess(prisma as never, LEAD_USER, ORG_ID, reply);
    expect(result).toBe(true);
  });

  it('returns false + sends 403 when user is not a member', async () => {
    const prisma = makePrisma(null);
    const reply = makeReply();
    const result = await assertOrgAccess(prisma as never, LEAD_USER, ORG_ID, reply);
    expect(result).toBe(false);
    expect(reply.status).toHaveBeenCalledWith(403);
  });
});

describe('isOrgOverBudget / assertOrgBudget', () => {
  const prisma = {} as never;
  function spent(finalizedUsd: number, inFlightUsd = 0, runlessUsd = 0) {
    spend.orgMonthSpend.mockResolvedValue({
      finalizedUsd,
      inFlightUsd,
      runlessUsd,
      totalUsd: finalizedUsd + inFlightUsd + runlessUsd,
    });
  }

  it('is never over budget without a cap, and does not read spend', async () => {
    spend.orgMonthSpend.mockClear();
    expect(await isOrgOverBudget(prisma, ORG_ID, null)).toBe(false);
    expect(spend.orgMonthSpend).not.toHaveBeenCalled();
  });

  it('is over budget once spend reaches the cap in cents', async () => {
    spent(9.99);
    expect(await isOrgOverBudget(prisma, ORG_ID, 1000)).toBe(false);
    spent(10);
    expect(await isOrgOverBudget(prisma, ORG_ID, 1000)).toBe(true);
  });

  it('counts the spend of runs still in flight and of runless workflows, not only finalized runs', async () => {
    spent(4, 5, 1);
    expect(await isOrgOverBudget(prisma, ORG_ID, 1000)).toBe(true);
    expect(spend.orgMonthSpend).toHaveBeenCalledWith(prisma, ORG_ID);
  });

  it('sends 402 ORG_BUDGET_EXCEEDED when over the cap', async () => {
    spent(20);
    const reply = makeReply();
    expect(await assertOrgBudget(prisma, ORG_ID, 1000, reply)).toBe(false);
    expect(reply.status).toHaveBeenCalledWith(402);
  });
});

describe('currentYearMonth', () => {
  it('returns a string matching YYYY-MM', () => {
    expect(currentYearMonth()).toMatch(/^\d{4}-\d{2}$/);
  });
});
