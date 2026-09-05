import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenRoutes } from './tokens.js';

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const mockPrisma = {
    configAuditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    personalAccessToken: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };

  const mockAuth = {
    hashToken: vi.fn().mockImplementation((t: string) => `hash:${t}`),
    // The real requireAuth() middleware reads `request.headers.authorization`,
    // strips `Bearer `, and calls `verifyAccessToken`. Returning a payload
    // here is how the workflow-templates tests already stub auth — we mirror
    // that pattern so the routes' role checks (`requireAuth({ requiredRole:
    // 'ENGINEER' })`) flow through unchanged.
    verifyAccessToken: () => ({
      exp: 9999999999,
      iat: 0,
      role: 'ENGINEER' as const,
      sub: 'user-1',
    }),
  };

  app.decorate('prisma', mockPrisma as unknown as never);
  app.decorate('auth', mockAuth as unknown as never);

  await app.register(tokenRoutes, { prefix: '/api/v1/auth/tokens' });
  await app.ready();

  return { app, mockAuth, mockPrisma };
}

const AUTH_HEADER = { authorization: 'Bearer fake-jwt' };

describe('tokenRoutes', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    ctx = await buildApp();
  });
  beforeEach(() => {
    // Tests share one app instance (cheap) but each one re-stubs Prisma
    // return values via `mockResolvedValueOnce`, so we need clean call
    // history between tests for the `toHaveBeenCalled` assertions.
    ctx.mockPrisma.configAuditLog.create.mockClear();
    ctx.mockPrisma.personalAccessToken.create.mockClear();
    ctx.mockPrisma.personalAccessToken.findMany.mockClear();
    ctx.mockPrisma.personalAccessToken.findUnique.mockClear();
    ctx.mockPrisma.personalAccessToken.update.mockClear();
  });
  afterAll(() => ctx.app.close());

  it('POST issues a plaintext token exactly once + persists the hash', async () => {
    ctx.mockPrisma.personalAccessToken.create.mockResolvedValueOnce({
      createdAt: new Date('2026-01-01'),
      expiresAt: null,
      id: 'pat-1',
      name: 'ci-token',
      prefix: 'ats_xxxxxxxx',
    });

    const res = await ctx.app.inject({
      headers: AUTH_HEADER,
      method: 'POST',
      payload: { name: 'ci-token' },
      url: '/api/v1/auth/tokens',
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.data.token).toMatch(/^ats_[A-Za-z0-9_-]+$/);
    expect(body.data.id).toBe('pat-1');
    // The plaintext is *only* in the response — the create call must persist
    // the sha-256 hash, never the raw token. (Our mock prefixes `hash:` for
    // traceability; with the real `crypto.createHash('sha256')` they would
    // diverge entirely. The hash must not equal the token.)
    const call = ctx.mockPrisma.personalAccessToken.create.mock.calls[0]?.[0];
    expect(call?.data.tokenHash).toMatch(/^hash:ats_/);
    expect(call?.data.tokenHash).not.toBe(body.data.token);
  });

  it('POST honors expiresInDays', async () => {
    ctx.mockPrisma.personalAccessToken.create.mockResolvedValueOnce({
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      id: 'pat-2',
      name: 'ephemeral',
      prefix: 'ats_yyyyyyyy',
    });
    await ctx.app.inject({
      headers: AUTH_HEADER,
      method: 'POST',
      payload: { expiresInDays: 7, name: 'ephemeral' },
      url: '/api/v1/auth/tokens',
    });
    const lastCall = ctx.mockPrisma.personalAccessToken.create.mock.calls.at(-1)?.[0];
    expect(lastCall?.data.expiresAt).toBeInstanceOf(Date);
  });

  it('GET lists only the requester’s tokens (no plaintext)', async () => {
    ctx.mockPrisma.personalAccessToken.findMany.mockResolvedValueOnce([
      {
        createdAt: new Date('2026-01-01'),
        expiresAt: null,
        id: 'pat-9',
        lastUsedAt: null,
        name: 'a',
        prefix: 'ats_aaaaaaaa',
        revokedAt: null,
      },
    ]);
    const res = await ctx.app.inject({
      headers: AUTH_HEADER,
      method: 'GET',
      url: '/api/v1/auth/tokens',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).not.toHaveProperty('token');
    expect(body.data[0]).not.toHaveProperty('tokenHash');
    const whereArg = ctx.mockPrisma.personalAccessToken.findMany.mock.calls.at(-1)?.[0];
    expect(whereArg?.where).toEqual({ userId: 'user-1' });
  });

  it('DELETE 404s when not owned', async () => {
    ctx.mockPrisma.personalAccessToken.findUnique.mockResolvedValueOnce({
      id: '11111111-1111-4111-8111-111111111111',
      revokedAt: null,
      userId: 'other-user',
    });
    const res = await ctx.app.inject({
      headers: AUTH_HEADER,
      method: 'DELETE',
      url: '/api/v1/auth/tokens/11111111-1111-4111-8111-111111111111',
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE marks the token revoked', async () => {
    ctx.mockPrisma.personalAccessToken.findUnique.mockResolvedValueOnce({
      id: '22222222-2222-4222-8222-222222222222',
      revokedAt: null,
      userId: 'user-1',
    });
    const revokedAt = new Date('2026-02-01');
    ctx.mockPrisma.personalAccessToken.update.mockResolvedValueOnce({
      id: '22222222-2222-4222-8222-222222222222',
      revokedAt,
    });
    const res = await ctx.app.inject({
      headers: AUTH_HEADER,
      method: 'DELETE',
      url: '/api/v1/auth/tokens/22222222-2222-4222-8222-222222222222',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data.revokedAt).toBeDefined();
  });

  it('DELETE on already-revoked is idempotent', async () => {
    const prior = new Date('2026-01-15');
    ctx.mockPrisma.personalAccessToken.findUnique.mockResolvedValueOnce({
      id: '33333333-3333-4333-8333-333333333333',
      revokedAt: prior,
      userId: 'user-1',
    });
    const res = await ctx.app.inject({
      headers: AUTH_HEADER,
      method: 'DELETE',
      url: '/api/v1/auth/tokens/33333333-3333-4333-8333-333333333333',
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.mockPrisma.personalAccessToken.update).not.toHaveBeenCalled();
  });

  it('POST writes a CREATE audit entry without plaintext token or tokenHash', async () => {
    ctx.mockPrisma.personalAccessToken.create.mockResolvedValueOnce({
      createdAt: new Date('2026-01-01'),
      expiresAt: null,
      id: 'pat-audit-1',
      name: 'audit-token',
      prefix: 'ats_abcdefgh',
      userId: 'user-1',
    });

    const res = await ctx.app.inject({
      headers: AUTH_HEADER,
      method: 'POST',
      payload: { name: 'audit-token' },
      url: '/api/v1/auth/tokens',
    });

    expect(res.statusCode).toBe(201);
    expect(ctx.mockPrisma.configAuditLog.create).toHaveBeenCalledTimes(1);
    const auditCall = ctx.mockPrisma.configAuditLog.create.mock.calls[0]?.[0];
    const serialized = JSON.stringify(auditCall);
    const body = JSON.parse(res.payload);
    expect(serialized).not.toContain(body.data.token);
    expect(serialized).not.toContain('tokenHash');
    expect(auditCall?.data).toMatchObject({
      action: 'CREATE',
      actorId: 'user-1',
      entityId: 'pat-audit-1',
      entityType: 'PersonalAccessToken',
    });
    expect(auditCall?.data.afterJson).toMatchObject({
      name: 'audit-token',
      prefix: 'ats_abcdefgh',
    });
  });

  it('DELETE writes an UPDATE audit entry with before and after snapshots', async () => {
    const tokenId = '44444444-4444-4444-8444-444444444444';
    ctx.mockPrisma.personalAccessToken.findUnique.mockResolvedValueOnce({
      expiresAt: null,
      id: tokenId,
      name: 'revoke-me',
      prefix: 'ats_abcdefgh',
      revokedAt: null,
      userId: 'user-1',
    });
    const revokedAt = new Date('2026-04-01');
    ctx.mockPrisma.personalAccessToken.update.mockResolvedValueOnce({
      expiresAt: null,
      id: tokenId,
      name: 'revoke-me',
      prefix: 'ats_abcdefgh',
      revokedAt,
      userId: 'user-1',
    });

    await ctx.app.inject({
      headers: AUTH_HEADER,
      method: 'DELETE',
      url: `/api/v1/auth/tokens/${tokenId}`,
    });

    const auditCall = ctx.mockPrisma.configAuditLog.create.mock.calls[0]?.[0];
    const serialized = JSON.stringify(auditCall);
    expect(serialized).not.toContain('tokenHash');
    expect(auditCall?.data).toMatchObject({
      action: 'UPDATE',
      actorId: 'user-1',
      entityId: tokenId,
      entityType: 'PersonalAccessToken',
    });
    expect(auditCall?.data.beforeJson.revokedAt).toBeNull();
    expect(auditCall?.data.afterJson.revokedAt).toBeDefined();
  });
});
