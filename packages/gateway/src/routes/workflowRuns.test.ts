import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workflowRunRoutes } from './workflowRuns.js';

function newMockPrisma() {
  return {
    workflowRun: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = newMockPrisma();
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'u-1' }),
  } as unknown as never);
  await app.register(workflowRunRoutes, { prefix: '/api/v1/workflow-runs' });
  await app.ready();
  return { app, prisma };
}

const AUTH = { authorization: 'Bearer fake' };

function lastListWhere(prisma: ReturnType<typeof newMockPrisma>) {
  return prisma.workflowRun.findMany.mock.calls[0][0].where as Record<string, unknown>;
}

beforeEach(() => vi.clearAllMocks());

describe('workflowRunRoutes GET / (list)', () => {
  it('excludes channel-assistant runs by default', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/workflow-runs' });
    expect(res.statusCode).toBe(200);
    const where = lastListWhere(prisma);
    expect(where.template).toEqual({ name: { not: 'Channel Assistant' } });
  });

  it('includes channel-assistant runs when includeChannel=true', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/workflow-runs?includeChannel=true',
    });
    expect(res.statusCode).toBe(200);
    const where = lastListWhere(prisma);
    expect(where.template).toBeUndefined();
  });

  it('does not add the channel exclusion when a templateId filter is set', async () => {
    const { app, prisma } = await buildApp();
    const templateId = '6f9619ff-8b86-4a08-8b86-3e6f9619ffd1';
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs?templateId=${templateId}`,
    });
    expect(res.statusCode).toBe(200);
    const where = lastListWhere(prisma);
    expect(where.template).toBeUndefined();
    expect(where.templateId).toBe(templateId);
  });
});
