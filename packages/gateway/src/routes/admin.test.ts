import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminRoutes, csvCell } from './admin.js';

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const mockPrisma = {
    configAuditLog: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    personalAccessToken: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    session: {
      delete: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
    },
    user: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    workflowShellAudit: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };

  app.decorate('prisma', mockPrisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'admin-1' }),
  } as unknown as never);

  await app.register(adminRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  return { app, mockPrisma };
}

const AUTH = { authorization: 'Bearer fake' };

describe('adminRoutes', () => {
  describe('GET /access-tokens', () => {
    let ctx: Awaited<ReturnType<typeof buildApp>>;
    beforeAll(async () => {
      ctx = await buildApp('ADMIN');
    });
    afterAll(() => ctx.app.close());

    it('returns all tokens with owning user email', async () => {
      ctx.mockPrisma.personalAccessToken.findMany.mockResolvedValueOnce([
        {
          createdAt: new Date('2026-01-01'),
          expiresAt: null,
          id: 'pat-1',
          lastUsedAt: null,
          name: 'ci',
          prefix: 'ats_xxxxxxxx',
          revokedAt: null,
          user: { email: 'alice@example.com', id: 'u-1' },
        },
      ]);
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/platform/access-tokens',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].user.email).toBe('alice@example.com');
      expect(body.data[0]).not.toHaveProperty('tokenHash');
    });

    it('returns 403 for non-admin', async () => {
      const { app } = await buildApp('ENGINEER');
      const res = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/platform/access-tokens',
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  describe('DELETE /access-tokens/:id', () => {
    let ctx: Awaited<ReturnType<typeof buildApp>>;
    beforeAll(async () => {
      ctx = await buildApp('ADMIN');
    });
    beforeEach(() => {
      ctx.mockPrisma.personalAccessToken.findUnique.mockReset();
      ctx.mockPrisma.personalAccessToken.update.mockReset();
    });
    afterAll(() => ctx.app.close());

    it('revokes any user’s token', async () => {
      ctx.mockPrisma.personalAccessToken.findUnique.mockResolvedValueOnce({
        id: '11111111-1111-4111-8111-111111111111',
        revokedAt: null,
        userId: 'other-user',
      });
      const revokedAt = new Date('2026-03-01');
      ctx.mockPrisma.personalAccessToken.update.mockResolvedValueOnce({
        id: '11111111-1111-4111-8111-111111111111',
        revokedAt,
      });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'DELETE',
        url: '/api/v1/platform/access-tokens/11111111-1111-4111-8111-111111111111',
      });
      expect(res.statusCode).toBe(200);
      expect(ctx.mockPrisma.personalAccessToken.update).toHaveBeenCalled();
    });

    it('returns 404 when token does not exist', async () => {
      ctx.mockPrisma.personalAccessToken.findUnique.mockResolvedValueOnce(null);
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'DELETE',
        url: '/api/v1/platform/access-tokens/22222222-2222-4222-8222-222222222222',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /shell-audit/prune', () => {
    let ctx: Awaited<ReturnType<typeof buildApp>>;
    beforeAll(async () => {
      ctx = await buildApp('ADMIN');
    });
    afterAll(() => ctx.app.close());

    it('prunes rows older than the default 90 days and returns count', async () => {
      ctx.mockPrisma.workflowShellAudit.deleteMany.mockResolvedValueOnce({ count: 42 });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'POST',
        url: '/api/v1/platform/shell-audit/prune',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data.deleted).toBe(42);
      expect(body.data.olderThanDays).toBe(90);
    });

    it('honors custom days query param', async () => {
      ctx.mockPrisma.workflowShellAudit.deleteMany.mockResolvedValueOnce({ count: 7 });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'POST',
        url: '/api/v1/platform/shell-audit/prune?days=30',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data.olderThanDays).toBe(30);
      const deleteCall = ctx.mockPrisma.workflowShellAudit.deleteMany.mock.calls.at(-1)?.[0];
      expect(deleteCall?.where?.createdAt?.lt).toBeInstanceOf(Date);
    });
  });

  describe('DELETE /sessions/:id', () => {
    let ctx: Awaited<ReturnType<typeof buildApp>>;
    beforeAll(async () => {
      ctx = await buildApp('ADMIN');
    });
    beforeEach(() => {
      ctx.mockPrisma.configAuditLog.create.mockClear();
      ctx.mockPrisma.session.delete.mockReset();
      ctx.mockPrisma.session.findUnique.mockReset();
    });
    afterAll(() => ctx.app.close());

    it('revokes a session and writes a DELETE audit entry without the full token', async () => {
      ctx.mockPrisma.session.findUnique.mockResolvedValueOnce({
        createdAt: new Date('2026-01-01'),
        expiresAt: new Date('2026-02-01'),
        id: '44444444-4444-4444-8444-444444444444',
        ipAddress: '127.0.0.1',
        token: 'full-bearer-secret-token',
        updatedAt: new Date('2026-01-01'),
        userAgent: 'Mozilla/5.0',
        userId: 'user-1',
      });
      ctx.mockPrisma.session.delete.mockResolvedValueOnce({});

      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'DELETE',
        url: '/api/v1/platform/sessions/44444444-4444-4444-8444-444444444444',
      });

      expect(res.statusCode).toBe(200);
      expect(ctx.mockPrisma.session.delete).toHaveBeenCalled();
      expect(ctx.mockPrisma.configAuditLog.create).toHaveBeenCalledTimes(1);
      const auditCall = ctx.mockPrisma.configAuditLog.create.mock.calls[0]?.[0];
      const serialized = JSON.stringify(auditCall);
      expect(serialized).not.toContain('full-bearer-secret-token');
      expect(auditCall?.data).toMatchObject({
        action: 'DELETE',
        actorId: 'admin-1',
        entityId: '44444444-4444-4444-8444-444444444444',
        entityType: 'Session',
      });
      expect(auditCall?.data.beforeJson.userId).toBe('user-1');
    });

    it('returns 404 when the session does not exist', async () => {
      ctx.mockPrisma.session.findUnique.mockResolvedValueOnce(null);
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'DELETE',
        url: '/api/v1/platform/sessions/22222222-2222-4222-8222-222222222222',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 403 for a non-ADMIN caller', async () => {
      const { app } = await buildApp('ENGINEER');
      const res = await app.inject({
        headers: AUTH,
        method: 'DELETE',
        url: '/api/v1/platform/sessions/11111111-1111-4111-8111-111111111111',
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  describe('session listing and bulk revoke', () => {
    const row = (id: string, token: string, userId = 'user-1') => ({
      createdAt: new Date('2026-01-01'),
      expiresAt: new Date('2026-02-01'),
      id,
      ipAddress: null,
      token,
      updatedAt: new Date('2026-01-01'),
      user: { email: 'a@example.com', id: userId },
      userAgent: null,
      userId,
    });
    const S1 = '44444444-4444-4444-8444-444444444444';
    const S2 = '55555555-5555-4555-8555-555555555555';
    const USER = '66666666-6666-4666-8666-666666666666';

    it('marks the session whose cookie the caller sent as current', async () => {
      const { app, mockPrisma } = await buildApp('ADMIN');
      mockPrisma.session.findMany.mockResolvedValueOnce([
        row(S1, 'mine-token-1234567890'),
        row(S2, 'other-token-1234567890'),
      ]);
      const res = await app.inject({
        headers: { ...AUTH, cookie: 'better-auth.session_token=mine-token-1234567890.sig' },
        method: 'GET',
        url: '/api/v1/platform/sessions',
      });
      const data = JSON.parse(res.payload).data;
      expect(data.map((r: { current: boolean }) => r.current)).toEqual([true, false]);
      expect(data[0].token).toBe('mine-tok…');
      await app.close();
    });

    it("revokes every session of a user except the caller's own", async () => {
      const { app, mockPrisma } = await buildApp('ADMIN');
      mockPrisma.session.findMany.mockResolvedValueOnce([
        row(S1, 'mine-token-1234567890', USER),
        row(S2, 'other-token-1234567890', USER),
      ]);
      mockPrisma.session.delete.mockResolvedValue({});
      const res = await app.inject({
        headers: { ...AUTH, cookie: 'better-auth.session_token=mine-token-1234567890.sig' },
        method: 'POST',
        payload: { userId: USER },
        url: '/api/v1/platform/sessions/revoke-user',
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data.revoked).toBe(1);
      expect(mockPrisma.session.delete).toHaveBeenCalledTimes(1);
      expect(mockPrisma.session.delete).toHaveBeenCalledWith({ where: { id: S2 } });
      expect(mockPrisma.configAuditLog.create).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it('refuses a non-admin caller', async () => {
      const { app } = await buildApp('ENGINEER');
      const res = await app.inject({
        headers: AUTH,
        method: 'POST',
        payload: { userId: USER },
        url: '/api/v1/platform/sessions/revoke-user',
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  describe('audit logging', () => {
    let ctx: Awaited<ReturnType<typeof buildApp>>;
    beforeAll(async () => {
      ctx = await buildApp('ADMIN');
    });
    beforeEach(() => {
      ctx.mockPrisma.configAuditLog.create.mockClear();
      ctx.mockPrisma.personalAccessToken.findUnique.mockReset();
      ctx.mockPrisma.personalAccessToken.update.mockReset();
    });
    afterAll(() => ctx.app.close());

    it('DELETE /access-tokens/:id writes an UPDATE audit entry without tokenHash', async () => {
      const tokenId = '55555555-5555-4555-8555-555555555555';
      ctx.mockPrisma.personalAccessToken.findUnique.mockResolvedValueOnce({
        expiresAt: null,
        id: tokenId,
        name: 'admin-revoked',
        prefix: 'ats_xxxxxxxx',
        revokedAt: null,
        tokenHash: 'sha256-of-secret',
        userId: 'user-2',
      });
      const revokedAt = new Date('2026-05-01');
      ctx.mockPrisma.personalAccessToken.update.mockResolvedValueOnce({
        expiresAt: null,
        id: tokenId,
        name: 'admin-revoked',
        prefix: 'ats_xxxxxxxx',
        revokedAt,
        userId: 'user-2',
      });

      await ctx.app.inject({
        headers: AUTH,
        method: 'DELETE',
        url: `/api/v1/platform/access-tokens/${tokenId}`,
      });

      expect(ctx.mockPrisma.configAuditLog.create).toHaveBeenCalledTimes(1);
      const auditCall = ctx.mockPrisma.configAuditLog.create.mock.calls[0]?.[0];
      const serialized = JSON.stringify(auditCall);
      expect(serialized).not.toContain('sha256-of-secret');
      expect(serialized).not.toContain('tokenHash');
      expect(auditCall?.data).toMatchObject({
        action: 'UPDATE',
        actorId: 'admin-1',
        entityId: tokenId,
        entityType: 'PersonalAccessToken',
      });
    });
  });

  describe('GET /audit-log', () => {
    let ctx: Awaited<ReturnType<typeof buildApp>>;
    beforeAll(async () => {
      ctx = await buildApp('ADMIN');
    });
    beforeEach(() => {
      ctx.mockPrisma.configAuditLog.findMany.mockReset().mockResolvedValue([]);
      ctx.mockPrisma.configAuditLog.count.mockReset().mockResolvedValue(0);
      ctx.mockPrisma.user.findMany.mockReset().mockResolvedValue([]);
    });
    afterAll(() => ctx.app.close());

    it('returns the first page with a total, entity types, and actor emails', async () => {
      ctx.mockPrisma.configAuditLog.findMany.mockResolvedValueOnce([
        {
          action: 'CREATE',
          actorId: '11111111-1111-4111-8111-111111111111',
          createdAt: new Date(),
          entityId: 'e1',
          entityType: 'User',
          id: 'a1',
        },
        {
          action: 'UPDATE',
          actorId: null,
          createdAt: new Date(),
          entityId: 'e2',
          entityType: 'Agent',
          id: 'a2',
        },
      ]);
      ctx.mockPrisma.configAuditLog.count.mockResolvedValueOnce(120);
      ctx.mockPrisma.configAuditLog.groupBy.mockResolvedValueOnce([
        { entityType: 'Agent' },
        { entityType: 'User' },
      ]);
      ctx.mockPrisma.user.findMany.mockResolvedValueOnce([
        { email: 'alice@example.com', id: '11111111-1111-4111-8111-111111111111', name: 'Alice' },
      ]);
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/platform/audit-log',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].actor).toEqual({ email: 'alice@example.com', name: 'Alice' });
      expect(body.data[1].actor).toBeNull();
      expect(body.meta).toEqual({
        entityTypes: ['Agent', 'User'],
        limit: 50,
        offset: 0,
        total: 120,
      });
      expect(ctx.mockPrisma.configAuditLog.findMany).toHaveBeenCalledWith({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 0,
        take: 50,
        where: {},
      });
      expect(ctx.mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['11111111-1111-4111-8111-111111111111'] } },
        })
      );
    });

    it('pushes every filter and the page window into the query', async () => {
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/platform/audit-log?limit=25&offset=50&action=DELETE&entityType=Session&actorId=11111111-1111-4111-8111-111111111111&since=2026-09-01&until=2026-09-30',
      });
      expect(res.statusCode).toBe(200);
      const where = {
        action: 'DELETE',
        actorId: '11111111-1111-4111-8111-111111111111',
        createdAt: {
          gte: new Date('2026-09-01T00:00:00.000Z'),
          lt: new Date('2026-10-01T00:00:00.000Z'),
        },
        entityType: 'Session',
      };
      expect(ctx.mockPrisma.configAuditLog.findMany).toHaveBeenCalledWith({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 50,
        take: 25,
        where,
      });
      expect(ctx.mockPrisma.configAuditLog.count).toHaveBeenCalledWith({ where });
      // No actors on the page, so no user lookup.
      expect(ctx.mockPrisma.user.findMany).not.toHaveBeenCalled();
    });

    it('matches free text against the actor, the entity type and the entity id', async () => {
      ctx.mockPrisma.user.findMany.mockResolvedValueOnce([{ id: 'u-1' }]);
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/platform/audit-log?search=alice',
      });
      expect(res.statusCode).toBe(200);
      expect(ctx.mockPrisma.configAuditLog.count).toHaveBeenCalledWith({
        where: {
          OR: [
            { entityId: { contains: 'alice', mode: 'insensitive' } },
            { entityType: { contains: 'alice', mode: 'insensitive' } },
            { actorId: { in: ['u-1'] } },
          ],
        },
      });
    });

    it('rejects a malformed date and an over-cap limit', async () => {
      for (const qs of ['since=yesterday', 'limit=500', 'action=PATCH']) {
        const res = await ctx.app.inject({
          headers: AUTH,
          method: 'GET',
          url: `/api/v1/platform/audit-log?${qs}`,
        });
        expect(res.statusCode).toBe(400);
      }
    });

    it('returns 403 for a non-ADMIN caller', async () => {
      const { app } = await buildApp('ENGINEER');
      const res = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/platform/audit-log',
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  describe('GET /audit-log/export', () => {
    let ctx: Awaited<ReturnType<typeof buildApp>>;
    beforeAll(async () => {
      ctx = await buildApp('ADMIN');
    });
    beforeEach(() => {
      ctx.mockPrisma.configAuditLog.findMany.mockReset().mockResolvedValue([]);
      ctx.mockPrisma.user.findMany.mockReset().mockResolvedValue([]);
    });
    afterAll(() => ctx.app.close());

    it('streams the filtered rows as CSV, defusing spreadsheet formulas', async () => {
      ctx.mockPrisma.configAuditLog.findMany.mockResolvedValueOnce([
        {
          action: 'UPDATE',
          actorId: '11111111-1111-4111-8111-111111111111',
          afterJson: { name: '=HYPERLINK("x")', role: 'ADMIN' },
          beforeJson: { role: 'ENGINEER' },
          createdAt: new Date('2026-09-02T10:00:00.000Z'),
          entityId: 'e1',
          entityType: 'User',
          id: 'a1',
        },
      ]);
      ctx.mockPrisma.user.findMany.mockResolvedValueOnce([
        { email: 'alice@example.com', id: '11111111-1111-4111-8111-111111111111' },
      ]);
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/platform/audit-log/export?action=UPDATE&since=2026-09-01',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('audit-log.csv');
      const lines = res.payload.trim().split('\n');
      expect(lines[0]).toBe('time,action,actor,entity_type,entity_id,before,after');
      expect(lines[1]).toContain('2026-09-02T10:00:00.000Z,UPDATE,alice@example.com,User,e1');
      // The JSON cell is quoted; a formula inside it is data, not a leading `=`.
      expect(lines[1]).toContain('"{""role"":""ENGINEER""}"');
      expect(ctx.mockPrisma.configAuditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            action: 'UPDATE',
            createdAt: { gte: new Date('2026-09-01T00:00:00.000Z') },
          },
        })
      );
    });

    it('is ADMIN-only', async () => {
      const { app } = await buildApp('ENGINEER');
      const res = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/platform/audit-log/export',
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  describe('csvCell', () => {
    it('quotes separators and neutralises a leading formula character', () => {
      expect(csvCell('a,b')).toBe('"a,b"');
      expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
      expect(csvCell(null)).toBe('');
    });
  });
});
