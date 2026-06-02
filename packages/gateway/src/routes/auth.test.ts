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
    // Support both forms of Prisma's $transaction: the array form (Promise.all)
    // and the interactive callback form (refresh rotation uses the latter, with
    // a conditional updateMany as the concurrency gate).
    $transaction: vi
      .fn()
      .mockImplementation((arg: Promise<unknown>[] | ((tx: unknown) => unknown)) =>
        typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg)
      ),
    refreshToken: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      // count: 1 → the rotation gate sees the token as freshly revoked (won the
      // race) and proceeds to mint the replacement.
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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

  app.decorate('prisma', mockPrisma as unknown as never);
  app.decorate('auth', mockAuth as unknown as never);

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

  it('returns 401 TOKEN_ROTATED without revoking the family when it loses the rotation race', async () => {
    ctx.mockPrisma.refreshToken.findUnique.mockResolvedValue(makeRefreshToken());
    ctx.mockPrisma.refreshToken.create.mockClear();
    ctx.mockPrisma.refreshToken.updateMany.mockClear();
    // Conditional revoke flips zero rows → a concurrent refresh already rotated
    // this token (benign double-submit), not theft.
    ctx.mockPrisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 0 });

    const res = await ctx.app.inject({
      cookies: { refreshToken: 'valid-token' },
      method: 'POST',
      url: '/api/v1/auth/refresh',
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload).error.code).toBe('TOKEN_ROTATED');
    // No replacement minted, and the family is left intact (no family revoke).
    expect(ctx.mockPrisma.refreshToken.create).not.toHaveBeenCalled();
    expect(ctx.mockPrisma.refreshToken.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { family: 'family-1' } })
    );
  });
});
