import { afterEach, describe, expect, it, vi } from 'vitest';

// The invite handler lazy-imports betterAuth.ts to send the magic link; the
// real module needs DATABASE_URL and BETTER_AUTH_SECRET at import.
const signInMagicLink = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../lib/betterAuth.js', () => ({
  getAuth: () => ({ api: { signInMagicLink } }),
}));

import { makeAuthedApp } from '../test/authedApp.js';
import { orgMembersRoutes } from './orgMembers.js';

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const PREFIX = '/api/v1/admin/organizations';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const TARGET_USER = '00000000-0000-4000-8000-0000000000bb';

const orgLockCalls: string[] = [];

const MEMBER_ROW = {
  createdAt: new Date(),
  id: 'row-1',
  orgId: ORG_ID,
  role: 'ORG_ADMIN',
  user: { email: 'lead@test.com', id: TARGET_USER, name: null, role: 'LEAD' },
  userId: TARGET_USER,
};

const auditCreate = vi.fn().mockResolvedValue({});
const userCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
  email: data.email,
  id: TARGET_USER,
  isActive: data.isActive,
  role: data.role,
}));

function buildApp(role: string, membershipRole: string | null = 'ORG_ADMIN') {
  let prisma: Record<string, unknown>;
  prisma = {
    $queryRaw: vi.fn(async () => {
      orgLockCalls.push(ORG_ID);
      return [{ id: ORG_ID }];
    }),
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma)),
    configAuditLog: { create: auditCreate },
    organizationMembership: {
      count: vi.fn().mockResolvedValue(2),
      create: vi.fn().mockResolvedValue(MEMBER_ROW),
      delete: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([MEMBER_ROW]),
      findUnique: vi
        .fn()
        .mockImplementation(({ where }: { where: { userId_orgId?: unknown; id?: string } }) => {
          if (where.id) {
            return Promise.resolve(MEMBER_ROW);
          }
          return Promise.resolve(membershipRole ? { id: 'row-1', role: membershipRole } : null);
        }),
      update: vi.fn().mockResolvedValue({ ...MEMBER_ROW, role: 'ORG_MEMBER' }),
    },
    user: { create: userCreate, findFirst: vi.fn().mockResolvedValue(null) },
  };
  const app = makeAuthedApp({ prisma, role, sub: USER_ID });
  // Register under the real prefix so a plugin that drops it is caught here.
  app.register(orgMembersRoutes, { prefix: PREFIX });
  return app;
}

describe('GET /:orgId/members', () => {
  afterEach(() => {
    vi.clearAllMocks();
    orgLockCalls.length = 0;
  });

  it('returns members list for org admin', async () => {
    const app = buildApp('ADMIN');
    await app.ready();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/${ORG_ID}/members` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data[0].userId).toBe(TARGET_USER);
  });

  it('returns 403 when non-member tries to list', async () => {
    const app = buildApp('LEAD', null);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/${ORG_ID}/members` });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /:orgId/members', () => {
  afterEach(() => {
    vi.clearAllMocks();
    orgLockCalls.length = 0;
  });

  it('creates a membership', async () => {
    const app = buildApp('ADMIN');
    await app.ready();
    const res = await app.inject({
      body: JSON.stringify({ role: 'ORG_MEMBER', userId: TARGET_USER }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: `${PREFIX}/${ORG_ID}/members`,
    });
    expect(res.statusCode).toBeOneOf([200, 201]);
    // The standard `{ data }` envelope, not a bare row.
    expect(JSON.parse(res.body).data.id).toBe('row-1');
    expect(orgLockCalls).toEqual([ORG_ID]);
    // Upstream's audit assertion: the entry is written with the locked change.
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'UPDATE',
        entityId: 'row-1',
        entityType: 'OrganizationMembership',
      }),
    });
  });

  it('allows an ORG_ADMIN who is only a platform ENGINEER to manage members', async () => {
    const app = buildApp('ENGINEER', 'ORG_ADMIN');
    await app.ready();
    const res = await app.inject({
      body: JSON.stringify({ role: 'ORG_MEMBER', userId: TARGET_USER }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: `${PREFIX}/${ORG_ID}/members`,
    });
    expect(res.statusCode).toBeOneOf([200, 201]);
  });

  it('returns 403 for a platform ENGINEER who is only an ORG_MEMBER', async () => {
    const app = buildApp('ENGINEER', 'ORG_MEMBER');
    await app.ready();
    const res = await app.inject({
      body: JSON.stringify({ role: 'ORG_MEMBER', userId: TARGET_USER }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: `${PREFIX}/${ORG_ID}/members`,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /:orgId/members/invite', () => {
  afterEach(() => {
    vi.clearAllMocks();
    orgLockCalls.length = 0;
  });

  const invite = async (role: string) => {
    const app = buildApp(role, 'ORG_ADMIN');
    await app.ready();
    return app.inject({
      body: JSON.stringify({ email: 'New@Example.com' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: `${PREFIX}/${ORG_ID}/members/invite`,
    });
  };

  it("leaves an org admin's invitee waiting for a platform admin's approval", async () => {
    const res = await invite('ENGINEER');

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).data).toMatchObject({ isActive: false, orgRole: 'ORG_MEMBER' });
    const { data } = userCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    // Inactive and unapproved is the approval queue; the address is verified
    // by the invitee following the link, not vouched for by the inviter.
    expect(data).toEqual({
      email: 'new@example.com',
      emailVerified: false,
      isActive: false,
      role: 'ENGINEER',
    });
    // The org membership and the magic link still go out.
    expect(orgLockCalls).toEqual([ORG_ID]);
    expect(signInMagicLink).toHaveBeenCalledTimes(1);
  });

  it("approves a platform admin's invitee at once", async () => {
    const res = await invite('ADMIN');

    expect(res.statusCode).toBe(201);
    const { data } = userCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      approvalSource: 'admin',
      approvedAt: expect.any(Date),
      emailVerified: true,
      isActive: true,
    });
  });
});

describe('PATCH /:orgId/members/:userId', () => {
  afterEach(() => {
    vi.clearAllMocks();
    orgLockCalls.length = 0;
  });

  it('returns 403 for a platform-ENGINEER who is only an ORG_MEMBER', async () => {
    const app = buildApp('ENGINEER', 'ORG_MEMBER');
    await app.ready();
    const res = await app.inject({
      body: JSON.stringify({ role: 'ORG_ADMIN' }),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
      url: `${PREFIX}/${ORG_ID}/members/${TARGET_USER}`,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('DELETE /:orgId/members/:userId', () => {
  afterEach(() => {
    vi.clearAllMocks();
    orgLockCalls.length = 0;
  });

  it('removes a membership', async () => {
    const app = buildApp('ADMIN');
    await app.ready();
    const res = await app.inject({
      method: 'DELETE',
      url: `${PREFIX}/${ORG_ID}/members/${TARGET_USER}`,
    });
    expect(res.statusCode).toBe(204);
    expect(orgLockCalls).toEqual([ORG_ID]);
  });

  it('returns 403 for a platform-ENGINEER who is only an ORG_MEMBER', async () => {
    const app = buildApp('ENGINEER', 'ORG_MEMBER');
    await app.ready();
    const res = await app.inject({
      method: 'DELETE',
      url: `${PREFIX}/${ORG_ID}/members/${TARGET_USER}`,
    });
    expect(res.statusCode).toBe(403);
  });
});
