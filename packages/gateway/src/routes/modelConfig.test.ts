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
  agent: { findMany: ReturnType<typeof vi.fn> };
  embeddingConfig: { findFirst: ReturnType<typeof vi.fn> };
}

function newMockPrisma(): MockPrisma {
  return {
    agent: { findMany: vi.fn().mockResolvedValue([]) },
    configAuditLog: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    embeddingConfig: { findFirst: vi.fn().mockResolvedValue(null) },
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
  await app.register(modelConfigRoutes, { prefix: '/api/v1/platform' });
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
        url: '/api/v1/platform/credentials',
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.data.maskedKey).toBe('****1234');
      expect(body.data.lastFour).toBe('1234');
      expect(JSON.stringify(body)).not.toContain('sk-anthropic-secret');
      const auditCall = ctx.mockPrisma.configAuditLog.create.mock.calls[0][0];
      expect(JSON.stringify(auditCall)).not.toContain('sk-anthropic-secret');
    });

    it('trims a pasted trailing newline or space from the key and apiBase before storing', async () => {
      ctx.mockPrisma.providerCredential.create.mockImplementationOnce(
        async (args: { data: Record<string, unknown> }) => ({
          ...args.data,
          createdAt: new Date(),
          id: 'cred-2',
          updatedAt: new Date(),
        })
      );
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'POST',
        payload: {
          apiBase: ' https://openrouter.ai/api/v1 \n',
          apiKey: '  sk-or-pasted-1234\n',
          provider: 'openrouter',
          scope: 'GLOBAL',
        },
        url: '/api/v1/platform/credentials',
      });
      expect(res.statusCode).toBe(201);
      const data = ctx.mockPrisma.providerCredential.create.mock.calls[0][0].data;
      expect(data.apiBase).toBe('https://openrouter.ai/api/v1');
      expect(JSON.parse(res.payload).data.lastFour).toBe('1234');
    });

    it('refuses a key with whitespace or control characters, and an apiBase with userinfo', async () => {
      for (const payload of [
        { apiKey: 'sk-abc\r\nX-Evil: 1', provider: 'openai' },
        { apiKey: 'sk abc', provider: 'openai' },
        {
          apiBase: 'https://bob:hunter2@openrouter.ai/api/v1',
          apiKey: 'sk-abc',
          provider: 'openrouter',
        },
      ]) {
        const res = await ctx.app.inject({
          headers: AUTH,
          method: 'POST',
          payload: { ...payload, scope: 'GLOBAL' },
          url: '/api/v1/platform/credentials',
        });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.payload).error.code).toBe('INVALID_CREDENTIAL');
        expect(res.payload).not.toMatch(/hunter2|sk-abc/);
      }
      expect(ctx.mockPrisma.providerCredential.create).not.toHaveBeenCalled();
    });

    it('rejects non-admin', async () => {
      const { app } = await buildAdminApp('ENGINEER');
      const res = await app.inject({
        headers: AUTH,
        method: 'POST',
        payload: { apiKey: 'sk-x', provider: 'anthropic', scope: 'GLOBAL' },
        url: '/api/v1/platform/credentials',
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
        url: '/api/v1/platform/credentials',
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
        url: '/api/v1/platform/credentials',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data[0]).not.toHaveProperty('apiKeyCiphertext');
      expect(body.data[0]).not.toHaveProperty('apiKeyNonce');
      expect(body.data[0]).not.toHaveProperty('apiKeyAuthTag');
      expect(body.data[0].maskedKey).toBe('****1234');
    });
  });

  describe('GET /credentials usage', () => {
    it('lists the agents and embedding config a credential backs', async () => {
      const ctx = await buildAdminApp('ADMIN');
      const base = {
        apiBase: null,
        createdAt: new Date(),
        createdById: null,
        keyVersion: 1,
        lastFour: '1234',
        provider: 'openai',
        scope: 'GLOBAL',
        teamId: null,
        updatedAt: new Date(),
      };
      ctx.mockPrisma.providerCredential.findMany.mockResolvedValueOnce([
        { ...base, id: 'cred-1' },
        { ...base, id: 'cred-2' },
      ]);
      ctx.mockPrisma.agent.findMany.mockResolvedValueOnce([
        { credentialId: 'cred-1', key: 'reviewer' },
        { credentialId: 'cred-1', key: 'reviewer' },
        { credentialId: 'cred-1', key: 'implementer' },
      ]);
      ctx.mockPrisma.embeddingConfig.findFirst.mockResolvedValueOnce({ credentialId: 'cred-2' });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/platform/credentials',
      });
      const [one, two] = JSON.parse(res.payload).data;
      expect(one.usage).toEqual({ agents: ['implementer', 'reviewer'], embedding: false });
      expect(two.usage).toEqual({ agents: [], embedding: true });
      await ctx.app.close();
    });
  });

  describe('custom provider API base', () => {
    it('rejects a non-built-in provider created without an API base', async () => {
      const ctx = await buildAdminApp('ADMIN');
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'POST',
        payload: { apiKey: 'sk-abc-1234', provider: 'openrouter', scope: 'GLOBAL' },
        url: '/api/v1/platform/credentials',
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('API_BASE_REQUIRED');
      expect(ctx.mockPrisma.providerCredential.create).not.toHaveBeenCalled();
      await ctx.app.close();
    });

    it('rejects clearing the API base of a custom provider', async () => {
      const ctx = await buildAdminApp('ADMIN');
      ctx.mockPrisma.providerCredential.findUnique.mockResolvedValueOnce({
        apiBase: 'https://example.com/v1',
        createdAt: new Date(),
        createdById: null,
        id: '11111111-1111-4111-8111-111111111111',
        keyVersion: 1,
        lastFour: '1234',
        provider: 'openrouter',
        scope: 'GLOBAL',
        teamId: null,
        updatedAt: new Date(),
      });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'PUT',
        payload: { apiBase: null },
        url: '/api/v1/platform/credentials/11111111-1111-4111-8111-111111111111',
      });
      expect(res.statusCode).toBe(400);
      await ctx.app.close();
    });
  });

  describe('private-network opt-in', () => {
    const CRED_ID = '22222222-2222-4222-8222-222222222222';
    const storedPrivate = {
      allowPrivateNetwork: true,
      apiBase: 'http://10.0.0.5:8000/v1',
      createdAt: new Date(),
      createdById: null,
      id: CRED_ID,
      keyVersion: 1,
      lastFour: '1234',
      orgId: null,
      provider: 'vllm',
      scope: 'GLOBAL',
      teamId: null,
      updatedAt: new Date(),
    };

    function echoCreate(ctx: Awaited<ReturnType<typeof buildAdminApp>>) {
      ctx.mockPrisma.providerCredential.create.mockImplementationOnce(
        async (args: { data: Record<string, unknown> }) => ({
          ...args.data,
          createdAt: new Date(),
          id: 'cred-p',
          updatedAt: new Date(),
        })
      );
    }

    it('creates a credential on a private apiBase when the admin opts in', async () => {
      const ctx = await buildAdminApp('ADMIN');
      echoCreate(ctx);
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'POST',
        payload: {
          allowPrivateNetwork: true,
          apiBase: 'http://10.0.0.5:8000/v1',
          apiKey: 'sk-abc-1234',
          provider: 'vllm',
          scope: 'GLOBAL',
        },
        url: '/api/v1/platform/credentials',
      });
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.payload).data.allowPrivateNetwork).toBe(true);
      expect(ctx.mockPrisma.providerCredential.create.mock.calls[0][0].data).toMatchObject({
        allowPrivateNetwork: true,
      });
      await ctx.app.close();
    });

    it('refuses a private apiBase without the opt-in', async () => {
      const ctx = await buildAdminApp('ADMIN');
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'POST',
        payload: {
          apiBase: 'http://10.0.0.5:8000/v1',
          apiKey: 'sk-abc-1234',
          provider: 'vllm',
          scope: 'GLOBAL',
        },
        url: '/api/v1/platform/credentials',
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('UNSAFE_API_BASE');
      expect(ctx.mockPrisma.providerCredential.create).not.toHaveBeenCalled();
      await ctx.app.close();
    });

    it.each([
      'http://127.0.0.1:11434/v1',
      'http://169.254.169.254/',
    ])('refuses %s even with the opt-in', async (apiBase) => {
      const ctx = await buildAdminApp('ADMIN');
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'POST',
        payload: {
          allowPrivateNetwork: true,
          apiBase,
          apiKey: 'sk-abc-1234',
          provider: 'vllm',
          scope: 'GLOBAL',
        },
        url: '/api/v1/platform/credentials',
      });
      expect(res.statusCode).toBe(400);
      const error = JSON.parse(res.payload).error;
      expect(error.code).toBe('UNSAFE_API_BASE');
      expect(error.message).toMatch(/never allowed/);
      await ctx.app.close();
    });

    it('re-checks the stored apiBase when only the opt-in is turned off', async () => {
      const ctx = await buildAdminApp('ADMIN');
      ctx.mockPrisma.providerCredential.findUnique.mockResolvedValueOnce(storedPrivate);
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'PUT',
        payload: { allowPrivateNetwork: false },
        url: `/api/v1/platform/credentials/${CRED_ID}`,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('UNSAFE_API_BASE');
      expect(ctx.mockPrisma.providerCredential.update).not.toHaveBeenCalled();
      await ctx.app.close();
    });

    it('keeps the stored opt-in when an update changes only the apiBase', async () => {
      const ctx = await buildAdminApp('ADMIN');
      ctx.mockPrisma.providerCredential.findUnique.mockResolvedValueOnce(storedPrivate);
      ctx.mockPrisma.providerCredential.update.mockImplementationOnce(
        async (args: { data: Record<string, unknown> }) => ({ ...storedPrivate, ...args.data })
      );
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'PUT',
        payload: { apiBase: 'http://192.168.1.20:8000/v1' },
        url: `/api/v1/platform/credentials/${CRED_ID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data.allowPrivateNetwork).toBe(true);
      await ctx.app.close();
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
        url: '/api/v1/platform/credentials',
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

describe('PUT /embedding-config — model catalog warnings', () => {
  async function saveEmbeddingSpec(modelSpec: string) {
    const { app, mockPrisma } = await buildAdminApp();
    Object.assign(mockPrisma, {
      embeddingConfig: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn(async () => ({ id: 'default', modelSpec })),
      },
      modelCatalogEntry: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue(null),
      },
    });
    const res = await app.inject({
      body: { modelSpec },
      headers: AUTH,
      method: 'PUT',
      url: '/api/v1/platform/embedding-config',
    });
    await app.close();
    return res;
  }

  it('saves a built-in embedding model without warnings', async () => {
    const res = await saveEmbeddingSpec('openai/text-embedding-3-large');
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('catalogWarnings');
  });

  it('saves a chat model, but warns it is not an embedding model', async () => {
    const res = await saveEmbeddingSpec('anthropic/claude-opus-5-5');
    expect(res.statusCode).toBe(200);
    expect(res.json().catalogWarnings).toEqual([
      "'anthropic/claude-opus-5-5' is cataloged as a chat model, but is being used as an embedding model.",
    ]);
  });
});
