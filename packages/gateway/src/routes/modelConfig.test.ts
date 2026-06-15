import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Ensure CONFIG_ENCRYPTION_KEY is set BEFORE any module that imports the crypto
// helper is evaluated. The helper caches the key lazily on first use.
process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');

import { modelConfigRoutes, teamScopedConfigRoutes } from './modelConfig.js';

// NOTE: per-role model config moved to the Agent library (P1.5); those routes
// + tests now live in agentLibrary.test.ts. This file covers the surviving
// credential + embedding + audit-log routes.

interface MockPrisma {
  providerCredential: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  configAuditLog: {
    create: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
}

function newMockPrisma(): MockPrisma {
  return {
    configAuditLog: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    providerCredential: {
      create: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
}

async function buildAdminApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const mockPrisma = newMockPrisma();
  app.decorate('prisma', mockPrisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'admin-1' }),
  } as unknown as never);
  await app.register(modelConfigRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  return { app, mockPrisma };
}

async function buildTeamApp(opts: {
  role?: 'ADMIN' | 'ENGINEER';
  teamMembership?: { role: 'ADMIN' | 'LEAD' | 'ENGINEER' } | null;
}) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const mockPrisma = newMockPrisma();
  (
    mockPrisma as unknown as { teamMembership: { findUnique: ReturnType<typeof vi.fn> } }
  ).teamMembership = {
    findUnique: vi.fn().mockResolvedValue(opts.teamMembership ?? null),
  };
  app.decorate('prisma', mockPrisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({
      exp: 9999999999,
      iat: 0,
      role: opts.role ?? 'ENGINEER',
      sub: 'u-1',
    }),
  } as unknown as never);
  await app.register(teamScopedConfigRoutes, { prefix: '/api/v1/teams' });
  await app.ready();
  return { app, mockPrisma };
}

const AUTH = { authorization: 'Bearer fake' };

describe('modelConfigRoutes — admin', () => {
  describe('POST /credentials', () => {
    let ctx: Awaited<ReturnType<typeof buildAdminApp>>;
    beforeEach(async () => {
      ctx = await buildAdminApp('ADMIN');
    });

    it('creates a credential and returns masked key, never plaintext', async () => {
      ctx.mockPrisma.providerCredential.create.mockImplementationOnce(
        async (args: { data: Record<string, unknown> }) => ({
          ...args.data,
          createdAt: new Date(),
          id: 'cred-1',
          updatedAt: new Date(),
        })
      );
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'POST',
        payload: {
          apiKey: 'sk-anthropic-secret-1234',
          provider: 'anthropic',
          scope: 'GLOBAL',
        },
        url: '/api/v1/admin/credentials',
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.data.maskedKey).toBe('****1234');
      expect(body.data.lastFour).toBe('1234');
      expect(JSON.stringify(body)).not.toContain('sk-anthropic-secret');
      const auditCall = ctx.mockPrisma.configAuditLog.create.mock.calls[0][0];
      expect(JSON.stringify(auditCall)).not.toContain('sk-anthropic-secret');
    });

    it('rejects non-admin', async () => {
      const { app } = await buildAdminApp('ENGINEER');
      const res = await app.inject({
        headers: AUTH,
        method: 'POST',
        payload: { apiKey: 'sk-x', provider: 'anthropic', scope: 'GLOBAL' },
        url: '/api/v1/admin/credentials',
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it('rejects duplicate at same scope', async () => {
      ctx.mockPrisma.providerCredential.findFirst.mockResolvedValueOnce({ id: 'existing' });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'POST',
        payload: { apiKey: 'sk-x', provider: 'anthropic', scope: 'GLOBAL' },
        url: '/api/v1/admin/credentials',
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('CREDENTIAL_EXISTS');
    });
  });

  describe('GET /credentials', () => {
    let ctx: Awaited<ReturnType<typeof buildAdminApp>>;
    beforeEach(async () => {
      ctx = await buildAdminApp('ADMIN');
    });

    it('never returns the encrypted bytes', async () => {
      ctx.mockPrisma.providerCredential.findMany.mockResolvedValueOnce([
        {
          apiBase: null,
          apiKeyAuthTag: Buffer.from('tag'),
          apiKeyCiphertext: Buffer.from('ciphertext'),
          apiKeyNonce: Buffer.from('nonce'),
          createdAt: new Date(),
          createdById: null,
          id: 'cred-1',
          keyVersion: 1,
          lastFour: '1234',
          provider: 'anthropic',
          scope: 'GLOBAL',
          teamId: null,
          updatedAt: new Date(),
        },
      ]);
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/admin/credentials',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data[0]).not.toHaveProperty('apiKeyCiphertext');
      expect(body.data[0]).not.toHaveProperty('apiKeyNonce');
      expect(body.data[0]).not.toHaveProperty('apiKeyAuthTag');
      expect(body.data[0].maskedKey).toBe('****1234');
    });
  });

  describe('audit-log redaction', () => {
    let ctx: Awaited<ReturnType<typeof buildAdminApp>>;
    beforeEach(async () => {
      ctx = await buildAdminApp('ADMIN');
    });

    it('never writes plaintext API key or encrypted bytes into ConfigAuditLog', async () => {
      ctx.mockPrisma.providerCredential.create.mockImplementationOnce(
        async (args: { data: Record<string, unknown> }) => ({
          ...args.data,
          createdAt: new Date(),
          id: 'cred-x',
          updatedAt: new Date(),
        })
      );
      await ctx.app.inject({
        headers: AUTH,
        method: 'POST',
        payload: {
          apiKey: 'sk-very-secret-plaintext-99',
          provider: 'anthropic',
          scope: 'GLOBAL',
        },
        url: '/api/v1/admin/credentials',
      });

      for (const call of ctx.mockPrisma.configAuditLog.create.mock.calls) {
        const serialized = JSON.stringify(call[0]);
        expect(serialized).not.toContain('sk-very-secret-plaintext');
        expect(serialized).not.toContain('apiKeyCiphertext');
        expect(serialized).not.toContain('apiKeyNonce');
        expect(serialized).not.toContain('apiKeyAuthTag');
      }
    });
  });

  describe('GET /config-audit-log', () => {
    let ctx: Awaited<ReturnType<typeof buildAdminApp>>;
    beforeEach(async () => {
      ctx = await buildAdminApp('ADMIN');
    });

    it('returns recent rows ordered by createdAt desc', async () => {
      ctx.mockPrisma.configAuditLog.findMany.mockResolvedValueOnce([
        { action: 'UPDATE', createdAt: new Date(), entityType: 'ProviderCredential', id: 'a1' },
      ]);
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/admin/config-audit-log?limit=10',
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data).toHaveLength(1);
      expect(ctx.mockPrisma.configAuditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'desc' }, take: 10 })
      );
    });
  });
});

describe('modelConfigRoutes — team-scoped credentials', () => {
  it('creates a team credential with masked response', async () => {
    const teamId = '99999999-9999-4999-8999-999999999999';
    const { app, mockPrisma } = await buildTeamApp({
      role: 'ENGINEER',
      teamMembership: { role: 'ADMIN' },
    });
    mockPrisma.providerCredential.create.mockImplementationOnce(
      async (args: { data: Record<string, unknown> }) => ({
        ...args.data,
        createdAt: new Date(),
        id: 'cred-team-1',
        updatedAt: new Date(),
      })
    );
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: {
        apiBase: 'https://opencode.ai/zen/go/v1',
        apiKey: 'sk-team-secret-5678',
        provider: 'opencodego',
      },
      url: `/api/v1/teams/${teamId}/credentials`,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.data.maskedKey).toBe('****5678');
    expect(body.data.scope).toBe('TEAM');
    expect(body.data.teamId).toBe(teamId);
    await app.close();
  });

  it('rejects a team engineer (insufficient role)', async () => {
    const { app } = await buildTeamApp({
      role: 'ENGINEER',
      teamMembership: { role: 'ENGINEER' },
    });
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/teams/55555555-5555-4555-8555-555555555555/credentials',
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
