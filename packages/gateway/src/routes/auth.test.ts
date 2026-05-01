import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { authRoutes } from './auth.js';

// ── Mock helpers ──

function makeUser(overrides = {}) {
  return {
    id: 'user-1',
    email: 'test@example.com',
    passwordHash: '$2b$10$placeholder', // bcrypt hash — overridden per test
    slackId: null,
    role: 'ENGINEER',
    isActive: true,
    ...overrides,
  };
}

function makeRefreshToken(overrides = {}) {
  return {
    id: 'rt-1',
    userId: 'user-1',
    tokenHash: 'hashed-token',
    family: 'family-1',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    revokedAt: null,
    createdAt: new Date(),
    user: makeUser(),
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
    user: {
      findUnique: vi.fn(),
    },
    refreshToken: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  const mockAuth = {
    signAccessToken: vi.fn().mockReturnValue('access-token-xyz'),
    generateRefreshToken: vi.fn().mockReturnValue('new-refresh-token'),
    hashToken: vi.fn().mockImplementation((t: string) => `hash:${t}`),
  };

  app.decorate('prisma', mockPrisma as any);
  app.decorate('auth', mockAuth as any);

  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.ready();

  return { app, mockPrisma, mockAuth };
}

// ── Login tests ──

describe('POST /api/v1/auth/login', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => { ctx = await buildApp(); });
  afterAll(() => ctx.app.close());

  it('returns 400 for missing email', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: 'secret' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 for unknown user', async () => {
    ctx.mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody@example.com', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload).error.code).toBe('AUTH_FAILED');
  });

  it('returns 401 for inactive user', async () => {
    ctx.mockPrisma.user.findUnique.mockResolvedValue(makeUser({ isActive: false }));
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'test@example.com', password: 'any' },
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
      url: '/api/v1/auth/login',
      payload: { email: 'test@example.com', password: 'password123' },
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
      url: '/api/v1/auth/login',
      payload: { email: 'test@example.com', password: 'pass' },
    });

    const body = JSON.parse(res.payload);
    expect(body.data.refreshToken).toBeUndefined();
  });
});

// ── Refresh tests ──

describe('POST /api/v1/auth/refresh', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => { ctx = await buildApp(); });
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
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { refreshToken: 'unknown-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload).error.code).toBe('TOKEN_INVALID');
  });

  it('returns 401 TOKEN_REUSE_DETECTED and revokes family when token already revoked', async () => {
    ctx.mockPrisma.refreshToken.findUnique.mockResolvedValue(
      makeRefreshToken({ revokedAt: new Date() }),
    );
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { refreshToken: 'revoked-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload).error.code).toBe('TOKEN_REUSE_DETECTED');
    expect(ctx.mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { family: 'family-1' } }),
    );
  });

  it('returns 401 TOKEN_EXPIRED for expired token', async () => {
    ctx.mockPrisma.refreshToken.findUnique.mockResolvedValue(
      makeRefreshToken({ expiresAt: new Date(Date.now() - 1000) }),
    );
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { refreshToken: 'expired-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload).error.code).toBe('TOKEN_EXPIRED');
  });

  it('returns 200 with new accessToken and rotates cookie on valid token', async () => {
    ctx.mockPrisma.refreshToken.findUnique.mockResolvedValue(makeRefreshToken());

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { refreshToken: 'valid-token' },
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
