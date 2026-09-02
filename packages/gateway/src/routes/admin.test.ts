import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminRoutes } from './admin.js';

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const mockPrisma = {
    personalAccessToken: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      update: vi.fn(),
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
});
