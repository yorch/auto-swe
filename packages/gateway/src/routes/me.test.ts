import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The settings registry and the revocation are exercised against real stores elsewhere
// (lib/mcpGrants.pg.test.ts); here the routes' own behaviour is what matters.
const mcpMocks = vi.hoisted(() => ({
  listMcpGrants: vi.fn(),
  resolveSettings: vi.fn(),
  revokeMcpGrants: vi.fn(),
}));
vi.mock('@auto-swe/shared/config', () => ({ resolveSettings: mcpMocks.resolveSettings }));
vi.mock('../lib/mcpGrants.js', () => ({
  listMcpGrants: mcpMocks.listMcpGrants,
  revokeMcpGrants: mcpMocks.revokeMcpGrants,
}));

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
        preferences: { runDetailLayout: 'A' },
      });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/me/preferences',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({
        preferences: { runDetailLayout: 'A' },
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
        preferences: { otherKey: 'keep-me', runDetailLayout: 'A' },
      });
      ctx.mockPrisma.user.update.mockResolvedValueOnce({
        preferences: { otherKey: 'keep-me', runDetailLayout: 'B' },
      });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload: { runDetailLayout: 'B' },
        url: '/api/v1/me/preferences',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({
        preferences: { otherKey: 'keep-me', runDetailLayout: 'B' },
      });
      expect(ctx.mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          // otherKey must be preserved from the existing preferences
          data: { preferences: { otherKey: 'keep-me', runDetailLayout: 'B' } },
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
        payload: { runDetailLayout: 'A', unknownKey: 'evil' },
        url: '/api/v1/me/preferences',
      });

      expect(res.statusCode).toBe(200);
      // The update was called with only the whitelisted key
      expect(ctx.mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { preferences: { runDetailLayout: 'A' } },
        })
      );
    });

    it('returns 401 without auth', async () => {
      const res = await ctx.app.inject({
        method: 'PATCH',
        payload: { runDetailLayout: 'B' },
        url: '/api/v1/me/preferences',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('MCP grants', () => {
    beforeEach(() => {
      mcpMocks.listMcpGrants.mockReset();
      mcpMocks.revokeMcpGrants.mockReset();
      mcpMocks.resolveSettings
        .mockReset()
        .mockResolvedValue({ 'mcp.enabled': false, 'mcp.writeToolsEnabled': false });
    });

    it('lists only the caller’s grants and reports the operator switches', async () => {
      mcpMocks.listMcpGrants.mockResolvedValueOnce([
        {
          clientId: 'c1',
          clientName: 'Claude Code',
          grantedAt: new Date('2026-01-02T00:00:00Z'),
          redirectUris: ['http://127.0.0.1:33333/cb'],
          scopes: ['mcp:read'],
        },
      ]);

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/me/mcp-grants',
      });

      expect(res.statusCode).toBe(200);
      expect(mcpMocks.listMcpGrants).toHaveBeenCalledWith(ctx.mockPrisma, 'user-1');
      expect(JSON.parse(res.payload)).toEqual({
        data: [
          {
            clientId: 'c1',
            clientName: 'Claude Code',
            grantedAt: '2026-01-02T00:00:00.000Z',
            redirectUris: ['http://127.0.0.1:33333/cb'],
            scopes: ['mcp:read'],
          },
        ],
        mcp: { enabled: false, writeToolsEnabled: false },
      });
    });

    it('revokes a grant as the caller, whatever the client id, and answers 204', async () => {
      mcpMocks.revokeMcpGrants.mockResolvedValueOnce(true);

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'DELETE',
        url: '/api/v1/me/mcp-grants/client-abc',
      });

      expect(res.statusCode).toBe(204);
      // The user id comes from the credential; a path cannot name another user's grant.
      expect(mcpMocks.revokeMcpGrants).toHaveBeenCalledWith(ctx.mockPrisma, {
        actorId: 'user-1',
        clientId: 'client-abc',
        userId: 'user-1',
      });
    });

    it('answers 404 when the caller holds no such grant', async () => {
      mcpMocks.revokeMcpGrants.mockResolvedValueOnce(false);
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'DELETE',
        url: '/api/v1/me/mcp-grants/someone-elses',
      });
      expect(res.statusCode).toBe(404);
    });

    it('requires authentication on both routes', async () => {
      const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/me/mcp-grants' });
      const del = await ctx.app.inject({ method: 'DELETE', url: '/api/v1/me/mcp-grants/c1' });
      expect(list.statusCode).toBe(401);
      expect(del.statusCode).toBe(401);
      expect(mcpMocks.revokeMcpGrants).not.toHaveBeenCalled();
    });
  });
});
