import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminRoutes } from './admin.js';

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const mockPrisma = {
    configAuditLog: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    personalAccessToken: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    session: {
      delete: vi.fn(),
      findUnique: vi.fn(),
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
      ctx.mockPrisma.configAuditLog.findMany.mockReset();
    });
    afterAll(() => ctx.app.close());

    it('returns the most recent 200 audit rows for ADMIN', async () => {
      ctx.mockPrisma.configAuditLog.findMany.mockResolvedValueOnce([
        {
          action: 'CREATE',
          actorId: 'admin-1',
          createdAt: new Date(),
          entityType: 'User',
          id: 'a1',
        },
      ]);
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/platform/audit-log',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data).toHaveLength(1);
      expect(ctx.mockPrisma.configAuditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'desc' }, take: 200 })
      );
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
});
