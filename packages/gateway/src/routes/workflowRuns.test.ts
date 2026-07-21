import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workflowRunRoutes } from './workflowRuns.js';

function newMockPrisma() {
  return {
    workflowRun: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = newMockPrisma();
  const temporal = { cancelWorkflow: vi.fn().mockResolvedValue(undefined) };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('temporal', temporal as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'u-1' }),
  } as unknown as never);
  await app.register(workflowRunRoutes, { prefix: '/api/v1/workflow-runs' });
  await app.ready();
  return { app, prisma, temporal };
}

const AUTH = { authorization: 'Bearer fake' };

function lastListWhere(prisma: ReturnType<typeof newMockPrisma>) {
  return prisma.workflowRun.findMany.mock.calls[0][0].where as Record<string, unknown>;
}

beforeEach(() => vi.clearAllMocks());

describe('workflowRunRoutes GET / (list)', () => {
  it('excludes channel chatter runs by default', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/workflow-runs' });
    expect(res.statusCode).toBe(200);
    const where = lastListWhere(prisma);
    expect(where.template).toEqual({ name: { notIn: ['Channel Assistant', 'Channel Task'] } });
  });

  it('includes channel chatter runs when includeChannel=true', async () => {
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

describe('workflowRunRoutes POST /:id/cancel', () => {
  const runId = '6f9619ff-8b86-4a08-8b86-3e6f9619ffd1';

  it('returns 409 and skips the Temporal cancel when the run already left RUNNING', async () => {
    const { app, prisma, temporal } = await buildApp();
    prisma.workflowRun.findFirst.mockResolvedValue({
      id: runId,
      status: 'RUNNING',
      workflowId: 'wf-1',
    });
    prisma.workflowRun.updateMany.mockResolvedValue({ count: 0 });
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: `/api/v1/workflow-runs/${runId}/cancel`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: 'RUN_NOT_RUNNING', message: 'Run reached a terminal state before cancel' },
    });
    expect(temporal.cancelWorkflow).not.toHaveBeenCalled();
  });

  it('cancels the Temporal workflow when the guarded update transitions exactly one row', async () => {
    const { app, prisma, temporal } = await buildApp();
    prisma.workflowRun.findFirst.mockResolvedValue({
      id: runId,
      status: 'RUNNING',
      workflowId: 'wf-1',
    });
    prisma.workflowRun.updateMany.mockResolvedValue({ count: 1 });
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: `/api/v1/workflow-runs/${runId}/cancel`,
    });
    expect(res.statusCode).toBe(200);
    expect(temporal.cancelWorkflow).toHaveBeenCalledWith('wf-1');
  });
});
