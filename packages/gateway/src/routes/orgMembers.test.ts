import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeAuthedApp } from '../test/authedApp.js';
import { orgMembersRoutes } from './orgMembers.js';

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const TARGET_USER = '00000000-0000-4000-8000-0000000000bb';

const MEMBER_ROW = {
  createdAt: new Date(),
  id: 'row-1',
  orgId: ORG_ID,
  role: 'ORG_ADMIN',
  user: { email: 'lead@test.com', id: TARGET_USER, name: null, role: 'LEAD' },
  userId: TARGET_USER,
};

function buildApp(role: string, membershipRole: string | null = 'ORG_ADMIN') {
  const app = makeAuthedApp({
    prisma: {
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
    },
    role,
    sub: USER_ID,
  });
  app.register(orgMembersRoutes);
  return app;
}

describe('GET /:orgId/members', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns members list for org admin', async () => {
    const app = buildApp('ADMIN');
    await app.ready();
    const res = await app.inject({ method: 'GET', url: `/${ORG_ID}/members` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].userId).toBe(TARGET_USER);
  });

  it('returns 403 when non-member tries to list', async () => {
    const app = buildApp('LEAD', null);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: `/${ORG_ID}/members` });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /:orgId/members', () => {
  afterEach(() => vi.clearAllMocks());

  it('creates a membership', async () => {
    const app = buildApp('ADMIN');
    await app.ready();
    const res = await app.inject({
      body: JSON.stringify({ role: 'ORG_MEMBER', userId: TARGET_USER }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: `/${ORG_ID}/members`,
    });
    expect(res.statusCode).toBeOneOf([200, 201]);
  });

  it('allows an ORG_ADMIN who is only a platform ENGINEER to manage members', async () => {
    const app = buildApp('ENGINEER', 'ORG_ADMIN');
    await app.ready();
    const res = await app.inject({
      body: JSON.stringify({ role: 'ORG_MEMBER', userId: TARGET_USER }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: `/${ORG_ID}/members`,
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
      url: `/${ORG_ID}/members`,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('PATCH /:orgId/members/:userId', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns 403 for a platform-ENGINEER who is only an ORG_MEMBER', async () => {
    const app = buildApp('ENGINEER', 'ORG_MEMBER');
    await app.ready();
    const res = await app.inject({
      body: JSON.stringify({ role: 'ORG_ADMIN' }),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
      url: `/${ORG_ID}/members/${TARGET_USER}`,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('DELETE /:orgId/members/:userId', () => {
  afterEach(() => vi.clearAllMocks());

  it('removes a membership', async () => {
    const app = buildApp('ADMIN');
    await app.ready();
    const res = await app.inject({
      method: 'DELETE',
      url: `/${ORG_ID}/members/${TARGET_USER}`,
    });
    expect(res.statusCode).toBe(204);
  });

  it('returns 403 for a platform-ENGINEER who is only an ORG_MEMBER', async () => {
    const app = buildApp('ENGINEER', 'ORG_MEMBER');
    await app.ready();
    const res = await app.inject({
      method: 'DELETE',
      url: `/${ORG_ID}/members/${TARGET_USER}`,
    });
    expect(res.statusCode).toBe(403);
  });
});
