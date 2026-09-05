vi.mock('@auto-swe/shared/db', () => ({
  PrismaClient: vi.fn(),
  prisma: {},
}));

import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { autonomyPolicyRoutes } from './autonomyPolicies.js';

const EXISTING = {
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  description: 'Default',
  id: '11111111-1111-4111-8111-111111111111',
  isDefault: true,
  name: 'Default',
  rules: { external_communication: { action: 'require_approval' } },
  team: null,
  teamId: null,
  template: null,
  templateId: null,
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

function newMockPrisma() {
  return {
    autonomyDecision: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    autonomyPolicy: {
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
        id: '22222222-2222-4222-8222-222222222222',
        ...data,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        description: data.description ?? null,
        team: null,
        teamId: data.teamId ?? null,
        template: null,
        templateId: data.templateId ?? null,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      })),
      delete: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(EXISTING),
      update: vi
        .fn()
        .mockImplementation(({ data }: { data: object }) => ({ ...EXISTING, ...data })),
    },
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
  };
}

let prisma: ReturnType<typeof newMockPrisma>;

async function buildApp(role: string = 'ADMIN') {
  prisma = newMockPrisma();
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(async (error, _request, reply) => {
    const typedError = error as { code?: string; message?: string; statusCode?: number };
    const statusCode = typedError.statusCode ?? 500;
    return reply.status(statusCode).send({
      error: {
        code: typedError.code ?? 'INTERNAL_ERROR',
        message:
          statusCode >= 500 ? 'Internal server error' : (typedError.message ?? 'Bad request'),
      },
    });
  });
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'admin-1' }),
  } as unknown as never);
  await app.register(autonomyPolicyRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  return app;
}

const AUTH = { authorization: 'Bearer fake' };

beforeEach(() => vi.clearAllMocks());

describe('GET /admin/autonomy-policies', () => {
  it('lists policies', async () => {
    const app = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/autonomy-policies',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data).toEqual([]);
    expect(prisma.autonomyPolicy.findMany).toHaveBeenCalled();
    await app.close();
  });

  it('requires admin role', async () => {
    const app = await buildApp('ENGINEER');
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/autonomy-policies',
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('POST /admin/autonomy-policies', () => {
  it('creates a global default policy', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: {
        description: 'Test default',
        isDefault: true,
        name: 'Test',
        rules: { internal_write: { action: 'auto' } },
      },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/autonomy-policies',
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.data.isDefault).toBe(true);
    expect(body.data.teamId).toBeNull();
    expect(body.data.templateId).toBeNull();
    expect(prisma.autonomyPolicy.create).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('rejects a policy with conflicting scope', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: {
        isDefault: true,
        name: 'Bad',
        rules: {},
        teamId: '11111111-1111-4111-8111-111111111111',
        templateId: '22222222-2222-4222-8222-222222222222',
      },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/autonomy-policies',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('INVALID_SCOPE');
    expect(prisma.autonomyPolicy.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('creates a team default policy', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: {
        description: 'Team default',
        isDefault: true,
        name: 'Team default',
        rules: {},
        teamId: '11111111-1111-4111-8111-111111111111',
      },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/autonomy-policies',
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.data.isDefault).toBe(true);
    expect(body.data.teamId).toBe('11111111-1111-4111-8111-111111111111');
    expect(body.data.templateId).toBeNull();
    expect(prisma.autonomyPolicy.create).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('creates a template override policy', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: {
        description: 'Template override',
        isDefault: false,
        name: 'Template override',
        rules: {},
        templateId: '22222222-2222-4222-8222-222222222222',
      },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/autonomy-policies',
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.data.isDefault).toBe(false);
    expect(body.data.teamId).toBeNull();
    expect(body.data.templateId).toBe('22222222-2222-4222-8222-222222222222');
    expect(prisma.autonomyPolicy.create).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('rejects a malformed rule action', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: {
        isDefault: true,
        name: 'Bad action',
        rules: { external_communication: { action: 'maybe_later' } },
      },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/autonomy-policies',
    });
    expect(res.statusCode).toBe(400);
    expect(prisma.autonomyPolicy.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects an invalid approverCount', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: {
        isDefault: true,
        name: 'Bad count',
        rules: { external_communication: { action: 'require_approval', approverCount: 0 } },
      },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/autonomy-policies',
    });
    expect(res.statusCode).toBe(400);
    expect(prisma.autonomyPolicy.create).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('PATCH /admin/autonomy-policies/:id', () => {
  it('updates a policy', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: { name: 'Updated' },
      headers: AUTH,
      method: 'PATCH',
      url: `/api/v1/platform/autonomy-policies/${EXISTING.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.name).toBe('Updated');
    expect(prisma.autonomyPolicy.update).toHaveBeenCalled();
    await app.close();
  });

  it('returns 404 for missing policy', async () => {
    const app = await buildApp();
    prisma.autonomyPolicy.findUnique.mockResolvedValueOnce(null);
    const res = await app.inject({
      body: { name: 'Updated' },
      headers: AUTH,
      method: 'PATCH',
      url: '/api/v1/platform/autonomy-policies/11111111-1111-4111-8111-111111111111',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 400 for a patch that leaves an invalid scope', async () => {
    const app = await buildApp();
    prisma.autonomyPolicy.findUnique.mockResolvedValueOnce({
      ...EXISTING,
      isDefault: true,
      teamId: null,
    });
    const res = await app.inject({
      body: { isDefault: false },
      headers: AUTH,
      method: 'PATCH',
      url: `/api/v1/platform/autonomy-policies/${EXISTING.id}`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('INVALID_SCOPE');
    expect(prisma.autonomyPolicy.update).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('DELETE /admin/autonomy-policies/:id', () => {
  it('deletes a policy', async () => {
    const app = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/platform/autonomy-policies/${EXISTING.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.deleted).toBe(true);
    expect(prisma.autonomyPolicy.delete).toHaveBeenCalled();
    await app.close();
  });
});

describe('GET /autonomy-decisions', () => {
  const DECISION = {
    actorId: '11111111-1111-4111-8111-111111111111',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    event: 'publish',
    id: '33333333-3333-4333-8333-333333333333',
    payload: { decision: 'auto' },
    policyName: 'Default',
    requiredApprovers: 1,
    riskClass: 'external_communication',
    runId: '44444444-4444-4444-8444-444444444444',
  };

  it('lists autonomy decisions for ADMIN', async () => {
    const app = await buildApp();
    prisma.autonomyDecision.findMany.mockResolvedValue([DECISION]);
    prisma.autonomyDecision.count.mockResolvedValue(1);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/autonomy-decisions',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(DECISION.id);
    expect(body.meta).toEqual({ limit: 50, offset: 0, total: 1 });
    await app.close();
  });

  it('applies text and UUID filters', async () => {
    const app = await buildApp();
    prisma.autonomyDecision.findMany.mockResolvedValue([DECISION]);
    prisma.autonomyDecision.count.mockResolvedValue(1);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/platform/autonomy-decisions?policyName=Default&riskClass=external&event=publish&actorId=${DECISION.actorId}&runId=${DECISION.runId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.autonomyDecision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          actorId: DECISION.actorId,
          event: { contains: 'publish', mode: 'insensitive' },
          policyName: { contains: 'Default', mode: 'insensitive' },
          riskClass: { contains: 'external', mode: 'insensitive' },
          runId: DECISION.runId,
        },
      })
    );
    await app.close();
  });

  it('enforces ADMIN only', async () => {
    const app = await buildApp('ENGINEER');
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/autonomy-decisions',
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
