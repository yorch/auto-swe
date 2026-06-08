import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { meRoutes } from './me.js';

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const mockPrisma = {
    user: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
  };

  const mockAuth = {
    verifyAccessToken: () => ({
      exp: 9999999999,
      iat: 0,
      role: 'ENGINEER' as const,
      sub: 'user-1',
    }),
  };

  app.decorate('prisma', mockPrisma as unknown as never);
  app.decorate('auth', mockAuth as unknown as never);

  await app.register(meRoutes, { prefix: '/api/v1/me' });
  await app.ready();

  return { app, mockPrisma };
}

const AUTH_HEADER = { authorization: 'Bearer fake-jwt' };

describe('meRoutes', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    ctx = await buildApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => {
    ctx.mockPrisma.user.findUniqueOrThrow.mockClear();
    ctx.mockPrisma.user.update.mockClear();
  });

  describe('GET /api/v1/me/preferences', () => {
    it('returns the user preferences', async () => {
      ctx.mockPrisma.user.findUniqueOrThrow.mockResolvedValueOnce({
        preferences: { runDetailLayout: 'split' },
      });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/me/preferences',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({
        preferences: { runDetailLayout: 'split' },
      });
    });

    it('returns 401 without auth', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me/preferences',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('PATCH /api/v1/me/preferences', () => {
    it('merges the new value and returns updated preferences', async () => {
      // Existing preferences has an extra key that should survive the patch
      ctx.mockPrisma.user.findUniqueOrThrow.mockResolvedValueOnce({
        preferences: { otherKey: 'keep-me', runDetailLayout: 'split' },
      });
      ctx.mockPrisma.user.update.mockResolvedValueOnce({
        preferences: { otherKey: 'keep-me', runDetailLayout: 'inline' },
      });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload: { runDetailLayout: 'inline' },
        url: '/api/v1/me/preferences',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({
        preferences: { otherKey: 'keep-me', runDetailLayout: 'inline' },
      });
      expect(ctx.mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          // otherKey must be preserved from the existing preferences
          data: { preferences: { otherKey: 'keep-me', runDetailLayout: 'inline' } },
        })
      );
    });

    it('strips unknown keys from the request body', async () => {
      ctx.mockPrisma.user.findUniqueOrThrow.mockResolvedValueOnce({
        preferences: {},
      });
      ctx.mockPrisma.user.update.mockResolvedValueOnce({ preferences: {} });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        // `unknownKey` is not in the Zod schema and should be stripped
        payload: { runDetailLayout: 'split', unknownKey: 'evil' },
        url: '/api/v1/me/preferences',
      });

      expect(res.statusCode).toBe(200);
      // The update was called with only the whitelisted key
      expect(ctx.mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { preferences: { runDetailLayout: 'split' } },
        })
      );
    });

    it('returns 401 without auth', async () => {
      const res = await ctx.app.inject({
        method: 'PATCH',
        payload: { runDetailLayout: 'inline' },
        url: '/api/v1/me/preferences',
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
