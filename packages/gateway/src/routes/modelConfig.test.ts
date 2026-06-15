import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Ensure CONFIG_ENCRYPTION_KEY is set BEFORE any module that imports the crypto
// helper is evaluated. The helper caches the key lazily on first use.
process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');

import { modelConfigRoutes, teamScopedConfigRoutes } from './modelConfig.js';

interface MockPrisma {
  modelRoleConfig: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
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
    modelRoleConfig: {
      create: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      update: vi.fn(),
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
  // The team-role check used by `requireAuth({ requiredTeamRole, teamIdParam })`
  // queries teamMembership. Stub it here.
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
  describe('GET /model-config', () => {
    let ctx: Awaited<ReturnType<typeof buildAdminApp>>;
    beforeAll(async () => {
      ctx = await buildAdminApp('ADMIN');
    });
    afterAll(() => ctx.app.close());

    it('lists rows with optional scope filter', async () => {
      ctx.mockPrisma.modelRoleConfig.findMany.mockResolvedValueOnce([
        {
          credential: null,
          id: 'r1',
          modelSpec: 'anthropic/opus',
          role: 'implementer',
          scope: 'GLOBAL',
        },
      ]);
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/admin/model-config?scope=GLOBAL',
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data).toHaveLength(1);
      expect(ctx.mockPrisma.modelRoleConfig.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ scope: 'GLOBAL' }) })
      );
    });

    it('rejects non-admin', async () => {
      const { app } = await buildAdminApp('ENGINEER');
      const res = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/admin/model-config',
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  describe('PUT /model-config', () => {
    let ctx: Awaited<ReturnType<typeof buildAdminApp>>;
    beforeEach(async () => {
      ctx = await buildAdminApp('ADMIN');
    });

    it('creates a new GLOBAL row', async () => {
      ctx.mockPrisma.modelRoleConfig.create.mockResolvedValueOnce({
        id: 'new-1',
        modelSpec: 'openai/gpt-5',
        role: 'implementer',
        scope: 'GLOBAL',
      });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'PUT',
        payload: { modelSpec: 'openai/gpt-5', role: 'implementer', scope: 'GLOBAL' },
        url: '/api/v1/admin/model-config',
      });
      expect(res.statusCode).toBe(201);
      expect(ctx.mockPrisma.configAuditLog.create).toHaveBeenCalled();
      expect(ctx.mockPrisma.configAuditLog.create.mock.calls[0][0].data.action).toBe('CREATE');
    });

    it('updates an existing row with audit log', async () => {
      ctx.mockPrisma.modelRoleConfig.findFirst.mockResolvedValueOnce({
        id: 'r1',
        modelSpec: 'anthropic/opus',
        role: 'implementer',
        scope: 'GLOBAL',
      });
      ctx.mockPrisma.modelRoleConfig.update.mockResolvedValueOnce({
        id: 'r1',
        modelSpec: 'openai/gpt-5',
        role: 'implementer',
        scope: 'GLOBAL',
      });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'PUT',
        payload: { modelSpec: 'openai/gpt-5', role: 'implementer', scope: 'GLOBAL' },
        url: '/api/v1/admin/model-config',
      });
      expect(res.statusCode).toBe(200);
      expect(ctx.mockPrisma.configAuditLog.create).toHaveBeenCalled();
      expect(ctx.mockPrisma.configAuditLog.create.mock.calls[0][0].data.action).toBe('UPDATE');
    });

    it('PUT round-trips systemPrompt on create', async () => {
      ctx.mockPrisma.modelRoleConfig.create.mockResolvedValueOnce({
        id: 'new-sp-1',
        modelSpec: 'anthropic/claude-opus-4-7',
        role: 'implementer',
        scope: 'GLOBAL',
        systemPrompt: 'You are a TypeScript expert.',
      });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'PUT',
        payload: {
          modelSpec: 'anthropic/claude-opus-4-7',
          role: 'implementer',
          scope: 'GLOBAL',
          systemPrompt: 'You are a TypeScript expert.',
        },
        url: '/api/v1/admin/model-config',
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.data.systemPrompt).toBe('You are a TypeScript expert.');
    });

    it('PUT accepts null systemPrompt to clear the override', async () => {
      // First create with a prompt
      ctx.mockPrisma.modelRoleConfig.findFirst.mockResolvedValueOnce({
        id: 'r-sp-1',
        modelSpec: 'anthropic/claude-opus-4-7',
        role: 'implementer',
        scope: 'GLOBAL',
        systemPrompt: 'initial prompt',
      });
      ctx.mockPrisma.modelRoleConfig.update.mockResolvedValueOnce({
        id: 'r-sp-1',
        modelSpec: 'anthropic/claude-opus-4-7',
        role: 'implementer',
        scope: 'GLOBAL',
        systemPrompt: null,
      });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'PUT',
        payload: {
          modelSpec: 'anthropic/claude-opus-4-7',
          role: 'implementer',
          scope: 'GLOBAL',
          systemPrompt: null,
        },
        url: '/api/v1/admin/model-config',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.systemPrompt).toBeNull();
    });

    it('rejects scope/key mismatch', async () => {
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'PUT',
        // scope=TEAM without teamId → schema validation fails
        payload: { modelSpec: 'openai/gpt-5', role: 'implementer', scope: 'TEAM' },
        url: '/api/v1/admin/model-config',
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects pinned credentialId that does not exist', async () => {
      ctx.mockPrisma.providerCredential.findUnique.mockResolvedValueOnce(null);
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'PUT',
        payload: {
          credentialId: '11111111-1111-4111-8111-111111111111',
          modelSpec: 'opencodego/glm-5',
          role: 'implementer',
          scope: 'GLOBAL',
        },
        url: '/api/v1/admin/model-config',
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('CREDENTIAL_NOT_FOUND');
    });
  });

  describe('DELETE /model-config/:id', () => {
    let ctx: Awaited<ReturnType<typeof buildAdminApp>>;
    beforeEach(async () => {
      ctx = await buildAdminApp('ADMIN');
    });

    it('refuses to delete a GLOBAL row', async () => {
      ctx.mockPrisma.modelRoleConfig.findUnique.mockResolvedValueOnce({
        id: '11111111-1111-4111-8111-111111111111',
        scope: 'GLOBAL',
      });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'DELETE',
        url: '/api/v1/admin/model-config/11111111-1111-4111-8111-111111111111',
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('CANNOT_DELETE_GLOBAL');
    });

    it('deletes a TEAM row and writes audit log', async () => {
      ctx.mockPrisma.modelRoleConfig.findUnique.mockResolvedValueOnce({
        id: '22222222-2222-4222-8222-222222222222',
        scope: 'TEAM',
      });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'DELETE',
        url: '/api/v1/admin/model-config/22222222-2222-4222-8222-222222222222',
      });
      expect(res.statusCode).toBe(200);
      expect(ctx.mockPrisma.modelRoleConfig.delete).toHaveBeenCalled();
      expect(ctx.mockPrisma.configAuditLog.create.mock.calls[0][0].data.action).toBe('DELETE');
    });
  });

  describe('GET /model-config/effective', () => {
    let ctx: Awaited<ReturnType<typeof buildAdminApp>>;
    beforeEach(async () => {
      ctx = await buildAdminApp('ADMIN');
    });

    it('returns the TEMPLATE row when present', async () => {
      ctx.mockPrisma.modelRoleConfig.findFirst.mockResolvedValueOnce({
        modelSpec: 'anthropic/template',
      });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/admin/model-config/effective?role=implementer&workflowTemplateId=33333333-3333-4333-8333-333333333333',
      });
      expect(JSON.parse(res.payload).data.scope).toBe('WORKFLOW_TEMPLATE');
    });

    it('falls back to GLOBAL', async () => {
      ctx.mockPrisma.modelRoleConfig.findFirst
        .mockResolvedValueOnce(null) // no template
        .mockResolvedValueOnce(null) // no team
        .mockResolvedValueOnce({ modelSpec: 'anthropic/global' }); // global
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/admin/model-config/effective?role=implementer&teamId=44444444-4444-4444-8444-444444444444&workflowTemplateId=33333333-3333-4333-8333-333333333333',
      });
      expect(JSON.parse(res.payload).data.scope).toBe('GLOBAL');
    });
  });

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
      // Plaintext key must not be in the response
      expect(JSON.stringify(body)).not.toContain('sk-anthropic-secret');
      // Audit log should also be redacted
      const auditCall = ctx.mockPrisma.configAuditLog.create.mock.calls[0][0];
      expect(JSON.stringify(auditCall)).not.toContain('sk-anthropic-secret');
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

      // Every call to configAuditLog.create must NOT contain plaintext apiKey or
      // any of the encrypted-bytes field names. Use a JSON string scan so we
      // catch nested copies too.
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
        { action: 'UPDATE', createdAt: new Date(), entityType: 'ModelRoleConfig', id: 'a1' },
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

describe('modelConfigRoutes — team-scoped', () => {
  describe('GET /teams/:id/model-config', () => {
    it('allows a team admin', async () => {
      const { app, mockPrisma } = await buildTeamApp({
        role: 'ENGINEER',
        teamMembership: { role: 'ADMIN' },
      });
      mockPrisma.modelRoleConfig.findMany.mockResolvedValueOnce([]);
      const res = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/teams/55555555-5555-4555-8555-555555555555/model-config',
      });
      expect(res.statusCode).toBe(200);
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
        url: '/api/v1/teams/55555555-5555-4555-8555-555555555555/model-config',
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  describe('PUT /teams/:id/model-config', () => {
    it('forces scope=TEAM and teamId from the URL', async () => {
      const teamId = '66666666-6666-4666-8666-666666666666';
      const { app, mockPrisma } = await buildTeamApp({
        role: 'ENGINEER',
        teamMembership: { role: 'ADMIN' },
      });
      mockPrisma.modelRoleConfig.create.mockResolvedValueOnce({ id: 'r1', scope: 'TEAM', teamId });
      const res = await app.inject({
        headers: AUTH,
        method: 'PUT',
        payload: { modelSpec: 'openai/gpt-5', role: 'implementer' },
        url: `/api/v1/teams/${teamId}/model-config`,
      });
      expect(res.statusCode).toBe(201);
      expect(mockPrisma.modelRoleConfig.create.mock.calls[0][0].data.scope).toBe('TEAM');
      expect(mockPrisma.modelRoleConfig.create.mock.calls[0][0].data.teamId).toBe(teamId);
      await app.close();
    });

    it('rejects a credentialId pointing at another team', async () => {
      const teamId = '77777777-7777-4777-8777-777777777777';
      const { app, mockPrisma } = await buildTeamApp({
        role: 'ENGINEER',
        teamMembership: { role: 'ADMIN' },
      });
      mockPrisma.providerCredential.findUnique.mockResolvedValueOnce({
        id: 'cred-other',
        scope: 'TEAM',
        teamId: 'other-team',
      });
      const res = await app.inject({
        headers: AUTH,
        method: 'PUT',
        payload: {
          credentialId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          modelSpec: 'opencodego/glm-5',
          role: 'implementer',
        },
        url: `/api/v1/teams/${teamId}/model-config`,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('CREDENTIAL_NOT_ACCESSIBLE');
      await app.close();
    });

    it('allows a GLOBAL credentialId', async () => {
      const teamId = '88888888-8888-4888-8888-888888888888';
      const { app, mockPrisma } = await buildTeamApp({
        role: 'ENGINEER',
        teamMembership: { role: 'ADMIN' },
      });
      mockPrisma.providerCredential.findUnique.mockResolvedValueOnce({
        id: 'cred-global',
        scope: 'GLOBAL',
        teamId: null,
      });
      mockPrisma.modelRoleConfig.create.mockResolvedValueOnce({ id: 'r1' });
      const res = await app.inject({
        headers: AUTH,
        method: 'PUT',
        payload: {
          credentialId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          modelSpec: 'opencodego/glm-5',
          role: 'implementer',
        },
        url: `/api/v1/teams/${teamId}/model-config`,
      });
      expect(res.statusCode).toBe(201);
      await app.close();
    });
  });

  describe('POST /teams/:id/credentials', () => {
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
  });
});
