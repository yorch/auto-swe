import { describe, expect, it, vi } from 'vitest';
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
  function budgetPrisma(spentUsd: number) {
    return {
      $transaction: vi.fn(),
      orgMonthlyUsage: { findUnique: vi.fn().mockResolvedValue({ costUsdAccrued: spentUsd }) },
    };
  }

  it('is never over budget without a cap, and does not read usage', async () => {
    const prisma = budgetPrisma(1_000_000);
    expect(await isOrgOverBudget(prisma as never, ORG_ID, null)).toBe(false);
    expect(prisma.orgMonthlyUsage.findUnique).not.toHaveBeenCalled();
  });

  it('is over budget once accrued spend reaches the cap in cents', async () => {
    expect(await isOrgOverBudget(budgetPrisma(9.99) as never, ORG_ID, 1000)).toBe(false);
    expect(await isOrgOverBudget(budgetPrisma(10) as never, ORG_ID, 1000)).toBe(true);
  });

  it('reads committed spend without a transaction or lock (best-effort cap)', async () => {
    const prisma = budgetPrisma(0);
    const reply = makeReply();
    expect(await assertOrgBudget(prisma as never, ORG_ID, 1000, reply)).toBe(true);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('sends 402 ORG_BUDGET_EXCEEDED when over the cap', async () => {
    const reply = makeReply();
    expect(await assertOrgBudget(budgetPrisma(20) as never, ORG_ID, 1000, reply)).toBe(false);
    expect(reply.status).toHaveBeenCalledWith(402);
  });
});

describe('currentYearMonth', () => {
  it('returns a string matching YYYY-MM', () => {
    expect(currentYearMonth()).toMatch(/^\d{4}-\d{2}$/);
  });
});
