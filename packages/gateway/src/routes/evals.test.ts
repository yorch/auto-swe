import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/skillScanner', () => ({
  scanSkillContent: vi.fn(async () => ({ warnings: ['heads up'] })),
}));

import { evalRoutes } from './evals.js';

function newMockPrisma() {
  return {
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    evalDataset: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
    },
    evalResult: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    evalRubric: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    evalRun: { create: vi.fn(), findUnique: vi.fn() },
  };
}

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = newMockPrisma();
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'admin-1' }),
  } as unknown as never);
  app.decorate('temporal', { startEvalRunWorkflow: async () => {} } as unknown as never);
  await app.register(evalRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  return { app, prisma };
}

const AUTH = { authorization: 'Bearer fake' };

beforeEach(() => vi.clearAllMocks());

describe('evalRoutes', () => {
  it('rejects non-admins', async () => {
    const { app } = await buildApp('ENGINEER');
    const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/platform/evals' });
    expect(res.statusCode).toBe(403);
  });

  it('lists datasets with a case count', async () => {
    const { app, prisma } = await buildApp();
    prisma.evalDataset.findMany.mockResolvedValue([
      {
        _count: { cases: 3 },
        createdAt: new Date('2026-06-24T00:00:00Z'),
        description: null,
        id: 'd1',
        name: 'SWE golden',
        scope: 'GLOBAL',
        slug: 'swe-golden',
      },
    ]);
    const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/platform/evals' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data[0]).toMatchObject({ caseCount: 3, slug: 'swe-golden' });
  });

  it('creates a dataset with cases and writes an audit log', async () => {
    const { app, prisma } = await buildApp();
    prisma.evalDataset.create.mockResolvedValue({
      _count: { cases: 1 },
      createdAt: new Date('2026-06-24T00:00:00Z'),
      description: null,
      id: 'd2',
      name: 'New',
      scope: 'GLOBAL',
      slug: 'new-set',
    });
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: {
        cases: [
          {
            baselineSha: 'abc123',
            goldenTest: 'yarn test',
            input: { t: 1 },
            repoUrl: 'https://x/y',
          },
        ],
        name: 'New',
        slug: 'new-set',
      },
      url: '/api/v1/platform/evals',
    });
    expect(res.statusCode).toBe(201);
    expect(prisma.evalDataset.create).toHaveBeenCalledTimes(1);
    // case was passed through to the nested create
    const createArg = prisma.evalDataset.create.mock.calls[0][0];
    expect(createArg.data.cases.create[0]).toMatchObject({
      baselineSha: 'abc123',
      repoUrl: 'https://x/y',
    });
    expect(prisma.configAuditLog.create).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid slug', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { name: 'X', slug: 'Bad Slug!' },
      url: '/api/v1/platform/evals',
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates a rubric, scans its text, and returns scan warnings', async () => {
    const { app, prisma } = await buildApp();
    prisma.evalRubric.create.mockResolvedValue({
      createdAt: new Date('2026-06-24T00:00:00Z'),
      id: 'ru1',
      isBuiltIn: false,
      promptText: 'grade it',
      scale: '0..1',
      scope: 'GLOBAL',
      slug: 'code-review-quality',
      version: 1,
    });
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { promptText: 'grade it', slug: 'code-review-quality' },
      url: '/api/v1/platform/evals/rubrics',
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.data.slug).toBe('code-review-quality');
    expect(body.scanWarnings).toEqual(['heads up']);
  });

  it('starts an eval run (202) after checking the dataset exists', async () => {
    const { app, prisma } = await buildApp();
    prisma.evalDataset.findUnique.mockResolvedValue({ id: 'd1' });
    prisma.evalRun.create.mockResolvedValue({
      baselineRef: 'last-release',
      candidateRef: 'main',
      datasetId: 'd1',
      endedAt: null,
      id: 'run-9',
      startedAt: new Date('2026-06-24T00:00:00Z'),
      status: 'RUNNING',
      summary: null,
    });
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: {
        baselineRef: 'last-release',
        candidateRef: 'main',
        datasetId: '11111111-1111-4111-8111-111111111111',
      },
      url: '/api/v1/platform/evals/runs',
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.payload).data.id).toBe('run-9');
  });

  it('404s starting a run for a missing dataset', async () => {
    const { app, prisma } = await buildApp();
    prisma.evalDataset.findUnique.mockResolvedValue(null);
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: {
        baselineRef: 'b',
        candidateRef: 'c',
        datasetId: '11111111-1111-4111-8111-111111111111',
      },
      url: '/api/v1/platform/evals/runs',
    });
    expect(res.statusCode).toBe(404);
  });

  it('queries results with pagination meta', async () => {
    const { app, prisma } = await buildApp();
    prisma.evalResult.findMany.mockResolvedValue([
      {
        agentKey: null,
        createdAt: new Date('2026-06-24T00:00:00Z'),
        id: 'e1',
        metadata: null,
        nodeId: 'runTests',
        passed: true,
        rationale: null,
        runId: 'r1',
        scorer: 'gate:runTests',
        scoreType: 'BOOLEAN',
        source: 'GATE',
        value: 1,
      },
    ]);
    prisma.evalResult.count.mockResolvedValue(1);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/evals/results?source=GATE&limit=10',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.meta).toEqual({ limit: 10, offset: 0, total: 1 });
    expect(body.data[0].scorer).toBe('gate:runTests');
    // the source filter reaches the where clause
    expect(prisma.evalResult.findMany.mock.calls[0][0].where).toMatchObject({ source: 'GATE' });
  });
});
