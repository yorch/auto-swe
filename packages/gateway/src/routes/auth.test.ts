import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authRoutes } from './auth.js';

// ── Mock helpers ──

function makeUser(overrides = {}) {
  return {
    email: 'test@example.com',
    id: 'user-1',
    isActive: true,
    passwordHash: '$2b$10$placeholder', // bcrypt hash — overridden per test
    role: 'ENGINEER',
    slackId: null,
    ...overrides,
  };
}

function makeRefreshToken(overrides = {}) {
  return {
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    family: 'family-1',
    id: 'rt-1',
    revokedAt: null,
    tokenHash: 'hashed-token',
    user: makeUser(),
    userId: 'user-1',
    ...overrides,
  };
}

// ── Test setup ──

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie);

  const mockPrisma = {
    $transaction: vi.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
    refreshToken: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({}),
    },
    user: {
      findUnique: vi.fn(),
    },
  };

  const mockAuth = {
    generateRefreshToken: vi.fn().mockReturnValue('new-refresh-token'),
    hashToken: vi.fn().mockImplementation((t: string) => `hash:${t}`),
    signAccessToken: vi.fn().mockReturnValue('access-token-xyz'),
  };

  app.decorate('prisma', mockPrisma as any);
  app.decorate('auth', mockAuth as any);

  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.ready();

  return { app, mockAuth, mockPrisma };
}

// ── Login tests ──

describe('POST /api/v1/auth/login', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    ctx = await buildApp();
  });
  afterAll(() => ctx.app.close());

  it('returns 400 for missing email', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      payload: { password: 'secret' },
      url: '/api/v1/auth/login',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 for unknown user', async () => {
    ctx.mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = await ctx.app.inject({
      method: 'POST',
      payload: { email: 'nobody@example.com', password: 'wrong' },
      url: '/api/v1/auth/login',
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload).error.code).toBe('AUTH_FAILED');
  });

  it('returns 401 for inactive user', async () => {
    ctx.mockPrisma.user.findUnique.mockResolvedValue(makeUser({ isActive: false }));
    const res = await ctx.app.inject({
      method: 'POST',
      payload: { email: 'test@example.com', password: 'any' },
      url: '/api/v1/auth/login',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 200 with accessToken and sets httpOnly refresh cookie on success', async () => {
    // bcrypt hash of "password123" — pre-computed to avoid slow bcrypt in tests
    const { default: bcrypt } = await import('bcrypt');
    const hash = await bcrypt.hash('password123', 1);
    ctx.mockPrisma.user.findUnique.mockResolvedValue(makeUser({ passwordHash: hash }));
    ctx.mockPrisma.refreshToken.findMany.mockResolvedValue([]);

    const res = await ctx.app.inject({
      method: 'POST',
      payload: { email: 'test@example.com', password: 'password123' },
      url: '/api/v1/auth/login',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data.accessToken).toBe('access-token-xyz');
    expect(body.data).not.toHaveProperty('refreshToken');

    const setCookie = res.headers['set-cookie'] as string;
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain('refreshToken=new-refresh-token');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/api/v1/auth/refresh');
  });

  it('does not include refreshToken in response body', async () => {
    const { default: bcrypt } = await import('bcrypt');
    const hash = await bcrypt.hash('pass', 1);
    ctx.mockPrisma.user.findUnique.mockResolvedValue(makeUser({ passwordHash: hash }));

    const res = await ctx.app.inject({
      method: 'POST',
      payload: { email: 'test@example.com', password: 'pass' },
      url: '/api/v1/auth/login',
    });

    const body = JSON.parse(res.payload);
    expect(body.data.refreshToken).toBeUndefined();
  });
});

// ── Refresh tests ──

describe('POST /api/v1/auth/refresh', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    ctx = await buildApp();
  });
  afterAll(() => ctx.app.close());

  it('returns 401 TOKEN_MISSING when no cookie', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload).error.code).toBe('TOKEN_MISSING');
  });

  it('returns 401 TOKEN_INVALID for unknown token', async () => {
    ctx.mockPrisma.refreshToken.findUnique.mockResolvedValue(null);
    const res = await ctx.app.inject({
      cookies: { refreshToken: 'unknown-token' },
      method: 'POST',
      url: '/api/v1/auth/refresh',
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload).error.code).toBe('TOKEN_INVALID');
  });

  it('returns 401 TOKEN_REUSE_DETECTED and revokes family when token already revoked', async () => {
    ctx.mockPrisma.refreshToken.findUnique.mockResolvedValue(
      makeRefreshToken({ revokedAt: new Date() })
    );
    const res = await ctx.app.inject({
      cookies: { refreshToken: 'revoked-token' },
      method: 'POST',
      url: '/api/v1/auth/refresh',
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload).error.code).toBe('TOKEN_REUSE_DETECTED');
    expect(ctx.mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { family: 'family-1' } })
    );
  });

  it('returns 401 TOKEN_EXPIRED for expired token', async () => {
    ctx.mockPrisma.refreshToken.findUnique.mockResolvedValue(
      makeRefreshToken({ expiresAt: new Date(Date.now() - 1000) })
    );
    const res = await ctx.app.inject({
      cookies: { refreshToken: 'expired-token' },
      method: 'POST',
      url: '/api/v1/auth/refresh',
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload).error.code).toBe('TOKEN_EXPIRED');
  });

  it('returns 200 with new accessToken and rotates cookie on valid token', async () => {
    ctx.mockPrisma.refreshToken.findUnique.mockResolvedValue(makeRefreshToken());

    const res = await ctx.app.inject({
      cookies: { refreshToken: 'valid-token' },
      method: 'POST',
      url: '/api/v1/auth/refresh',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data.accessToken).toBe('access-token-xyz');
    expect(body.data.refreshToken).toBeUndefined();

    const setCookie = res.headers['set-cookie'] as string;
    expect(setCookie).toContain('refreshToken=new-refresh-token');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/api/v1/auth/refresh');
  });
});
