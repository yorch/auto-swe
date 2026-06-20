import { describe, expect, it, vi } from 'vitest';
import { assertOrgAccess, currentYearMonth } from './orgAccess.js';

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

describe('currentYearMonth', () => {
  it('returns a string matching YYYY-MM', () => {
    expect(currentYearMonth()).toMatch(/^\d{4}-\d{2}$/);
  });
});
