vi.mock('@auto-swe/shared/db', () => ({
  PrismaClient: vi.fn(),
  prisma: {},
}));

import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { autonomyPolicyRoutes } from './autonomyPolicies.js';

const EXISTING = {
  description: 'Default',
  id: '11111111-1111-4111-8111-111111111111',
  isDefault: true,
  name: 'Default',
  rules: { external_communication: { action: 'require_approval' } },
  teamId: null,
  templateId: null,
};

function newMockPrisma() {
  return {
    autonomyPolicy: {
      create: vi.fn().mockImplementation(({ data }: { data: object }) => ({ id: 'new', ...data })),
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
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'admin-1' }),
  } as unknown as never);
  await app.register(autonomyPolicyRoutes, { prefix: '/api/v1/admin' });
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
      url: '/api/v1/admin/autonomy-policies',
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
      url: '/api/v1/admin/autonomy-policies',
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
      url: '/api/v1/admin/autonomy-policies',
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
      },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/admin/autonomy-policies',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('INVALID_SCOPE');
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
      url: `/api/v1/admin/autonomy-policies/${EXISTING.id}`,
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
      url: '/api/v1/admin/autonomy-policies/11111111-1111-4111-8111-111111111111',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('DELETE /admin/autonomy-policies/:id', () => {
  it('deletes a policy', async () => {
    const app = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/admin/autonomy-policies/${EXISTING.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.deleted).toBe(true);
    expect(prisma.autonomyPolicy.delete).toHaveBeenCalled();
    await app.close();
  });
});
