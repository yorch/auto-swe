import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/skillScanner', () => ({
  scanSkillContent: vi.fn(async () => ({ warnings: ['heads up'] })),
}));

const { recordRunFinalized } = vi.hoisted(() => ({ recordRunFinalized: vi.fn() }));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: vi.fn(async () => ({
    evalHealthMaxFlakeRate: 0.1,
    evalHealthMaxStaleRate: 0.2,
    evalHealthMinKappa: 0.4,
  })),
}));
vi.mock('../lib/metrics.js', () => ({ recordRunFinalized }));

import { evalRoutes } from './evals.js';

function newMockPrisma() {
  return {
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    evalCase: { groupBy: vi.fn().mockResolvedValue([]) },
    evalDataset: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
    },
    evalResult: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    evalRubric: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    evalRun: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
}

async function buildApp(
  role: 'ADMIN' | 'ENGINEER' = 'ADMIN',
  startEvalRunWorkflow: () => Promise<void> = async () => {}
) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = newMockPrisma();
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'admin-1' }),
  } as unknown as never);
  app.decorate('temporal', { startEvalRunWorkflow } as unknown as never);
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

  it('marks a run whose workflow failed to start FAILED, and counts it as finalized', async () => {
    const { app, prisma } = await buildApp('ADMIN', async () => {
      throw new Error('temporal unreachable');
    });
    prisma.evalDataset.findUnique.mockResolvedValue({ id: 'd1' });
    prisma.evalRun.create.mockResolvedValue({ id: 'run-10' });
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
    expect(res.statusCode).toBe(502);
    expect(prisma.evalRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'run-10' } })
    );
    expect(recordRunFinalized).toHaveBeenCalledExactlyOnceWith('FAILED', 'eval');
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
        caseId: null,
        createdAt: new Date('2026-06-24T00:00:00Z'),
        evalRunId: 'er1',
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
    expect(body.data[0]).toMatchObject({ caseId: null, evalRunId: 'er1', runId: 'r1' });
    // the source filter reaches the where clause
    expect(prisma.evalResult.findMany.mock.calls[0][0].where).toMatchObject({ source: 'GATE' });
  });

  it('filters results by every eval signal source, including policy signals', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/evals/results?source=POLICY&scorer=policy:x&offset=50',
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.evalResult.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 50,
        where: { scorer: 'policy:x', source: 'POLICY' },
      })
    );
  });

  describe('GET /evals/trends', () => {
    it('buckets each scorer by UTC day and folds the window mean from the days', async () => {
      vi.useFakeTimers({ now: new Date('2026-09-10T12:00:00Z'), toFake: ['Date'] });
      try {
        const { app, prisma } = await buildApp();
        prisma.evalResult.groupBy.mockImplementation(
          async ({ where }: { where: { createdAt: { gte: Date } } }) => {
            const day = where.createdAt.gte.toISOString().slice(0, 10);
            if (day === '2026-09-09') {
              return [{ _avg: { value: 1 }, _count: { _all: 3 }, scorer: 'gate:runTests' }];
            }
            if (day === '2026-09-10') {
              return [
                { _avg: { value: 0 }, _count: { _all: 1 }, scorer: 'gate:runTests' },
                { _avg: { value: 0.5 }, _count: { _all: 2 }, scorer: 'merge' },
              ];
            }
            return [];
          }
        );
        const res = await app.inject({
          headers: AUTH,
          method: 'GET',
          url: '/api/v1/platform/evals/trends?window=7&source=GATE',
        });
        expect(res.statusCode).toBe(200);
        const { data } = JSON.parse(res.payload);
        // One bounded aggregate per day, each carrying the source filter.
        expect(prisma.evalResult.groupBy).toHaveBeenCalledTimes(7);
        expect(prisma.evalResult.groupBy.mock.calls[0][0].where).toMatchObject({
          createdAt: {
            gte: new Date('2026-09-04T00:00:00Z'),
            lt: new Date('2026-09-05T00:00:00Z'),
          },
          source: 'GATE',
        });
        expect(data.windowDays).toBe(7);
        expect(data.since).toBe('2026-09-04T00:00:00.000Z');
        expect(data.until).toBe('2026-09-11T00:00:00.000Z');
        const gate = data.scorers.find((s: { scorer: string }) => s.scorer === 'gate:runTests');
        expect(gate.n).toBe(4);
        expect(gate.mean).toBeCloseTo(0.75);
        expect(gate.daily).toHaveLength(7);
        expect(gate.daily[0]).toEqual({ date: '2026-09-04', mean: null, n: 0 });
        expect(gate.daily[5]).toEqual({ date: '2026-09-09', mean: 1, n: 3 });
        expect(gate.daily[6]).toEqual({ date: '2026-09-10', mean: 0, n: 1 });
        expect(data.scorers.map((s: { scorer: string }) => s.scorer)).toEqual([
          'gate:runTests',
          'merge',
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('splits each scorer by the requested dimension and filters by template', async () => {
      vi.useFakeTimers({ now: new Date('2026-09-10T12:00:00Z'), toFake: ['Date'] });
      try {
        const { app, prisma } = await buildApp();
        const TEMPLATE = '22222222-2222-4222-8222-222222222222';
        prisma.evalResult.groupBy.mockImplementation(
          async ({ where }: { where: { createdAt: { gte: Date } } }) =>
            where.createdAt.gte.toISOString().startsWith('2026-09-10')
              ? [
                  { _avg: { value: 1 }, _count: { _all: 1 }, judgeModel: 'a/x', scorer: 'judge' },
                  { _avg: { value: 0 }, _count: { _all: 3 }, judgeModel: 'b/y', scorer: 'judge' },
                  { _avg: { value: 0.5 }, _count: { _all: 2 }, judgeModel: null, scorer: 'judge' },
                ]
              : []
        );
        const res = await app.inject({
          headers: AUTH,
          method: 'GET',
          url: `/api/v1/platform/evals/trends?window=7&by=judgeModel&templateId=${TEMPLATE}`,
        });
        expect(res.statusCode).toBe(200);
        const call = prisma.evalResult.groupBy.mock.calls[0][0];
        expect(call.by).toEqual(['scorer', 'judgeModel']);
        expect(call.where.run).toEqual({ templateId: TEMPLATE });
        const { data } = JSON.parse(res.payload);
        expect(data.by).toBe('judgeModel');
        expect(
          data.scorers.map((s: { breakdown: string | null; n: number }) => [s.breakdown, s.n])
        ).toEqual([
          [null, 2],
          ['a/x', 1],
          ['b/y', 3],
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects an unknown breakdown dimension', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/platform/evals/trends?by=scorer',
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a window outside 7/30/90', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/platform/evals/trends?window=365',
      });
      expect(res.statusCode).toBe(400);
    });

    it('serves a custom range of whole UTC days', async () => {
      const { app, prisma } = await buildApp();
      prisma.evalResult.groupBy.mockResolvedValue([]);
      const res = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/platform/evals/trends?since=2026-01-10&until=2026-01-12',
      });
      expect(res.statusCode).toBe(200);
      const { data } = JSON.parse(res.payload);
      expect(data.windowDays).toBe(3);
      expect(data.since).toBe('2026-01-10T00:00:00.000Z');
      expect(data.until).toBe('2026-01-13T00:00:00.000Z');
      expect(prisma.evalResult.groupBy).toHaveBeenCalledTimes(3);
    });

    it('rejects a half-given or backwards custom range', async () => {
      const { app } = await buildApp();
      for (const qs of ['since=2026-01-10', 'since=2026-01-10&until=2026-01-01']) {
        const res = await app.inject({
          headers: AUTH,
          method: 'GET',
          url: `/api/v1/platform/evals/trends?${qs}`,
        });
        expect(res.statusCode).toBe(400);
      }
    });

    it('is ADMIN-only', async () => {
      const { app } = await buildApp('ENGINEER');
      const res = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/platform/evals/trends',
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /evals/runs', () => {
    it("lists a dataset's runs newest first with a total", async () => {
      const { app, prisma } = await buildApp();
      prisma.evalRun.findMany.mockResolvedValue([
        {
          baselineRef: 'main',
          candidateRef: 'feat',
          dataset: { name: 'Golden tickets', slug: 'golden' },
          datasetId: '11111111-1111-4111-8111-111111111111',
          endedAt: null,
          id: 'run-a',
          startedAt: new Date('2026-09-01T00:00:00Z'),
          status: 'RUNNING',
          summary: null,
        },
      ]);
      prisma.evalRun.count.mockResolvedValue(21);
      const res = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/platform/evals/runs?datasetId=11111111-1111-4111-8111-111111111111&offset=20',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.meta).toEqual({ limit: 20, offset: 20, total: 21 });
      expect(body.data[0]).toMatchObject({
        datasetName: 'Golden tickets',
        datasetSlug: 'golden',
        endedAt: null,
        id: 'run-a',
        status: 'RUNNING',
      });
      expect(prisma.evalRun.findMany).toHaveBeenCalledWith({
        include: { dataset: { select: { name: true, slug: true } } },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        skip: 20,
        take: 20,
        where: { datasetId: '11111111-1111-4111-8111-111111111111' },
      });
    });

    it('flags a run whose verdict covers only some of the cases', async () => {
      const { app, prisma } = await buildApp();
      const base = {
        baselineRef: 'main',
        candidateRef: 'feat',
        datasetId: '11111111-1111-4111-8111-111111111111',
        endedAt: new Date('2026-09-01T01:00:00Z'),
        startedAt: new Date('2026-09-01T00:00:00Z'),
        status: 'SUCCESS',
      };
      prisma.evalRun.findMany.mockResolvedValue([
        { ...base, id: 'full', summary: { summary: 'ok' } },
        { ...base, id: 'part', summary: { partial: { completedCases: 2, totalCases: 5 } } },
        { ...base, id: 'none', summary: null },
      ]);
      const res = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/platform/evals/runs',
      });
      expect(JSON.parse(res.payload).data.map((r: { partial: boolean }) => r.partial)).toEqual([
        false,
        true,
        false,
      ]);
    });

    it('is ADMIN-only', async () => {
      const { app } = await buildApp('ENGINEER');
      const res = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/platform/evals/runs',
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /evals/suite-health', () => {
    it('reports each dataset’s quarantined share beside the gate thresholds', async () => {
      const { app, prisma } = await buildApp();
      prisma.evalDataset.findMany.mockResolvedValue([
        { id: 'd2', name: 'Empty', slug: 'empty' },
        { id: 'd1', name: 'Bench', slug: 'bench' },
      ]);
      prisma.evalCase.groupBy.mockResolvedValue([
        { _count: { _all: 6 }, datasetId: 'd1', flakeScreened: true, quarantined: false },
        { _count: { _all: 1 }, datasetId: 'd1', flakeScreened: true, quarantined: true },
        { _count: { _all: 1 }, datasetId: 'd1', flakeScreened: false, quarantined: true },
      ]);
      const res = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/platform/evals/suite-health',
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data).toEqual({
        datasets: [
          {
            cases: 8,
            datasetId: 'd1',
            flakeScreened: 7,
            name: 'Bench',
            quarantined: 2,
            slug: 'bench',
            staleRate: 0.25,
          },
          {
            cases: 0,
            datasetId: 'd2',
            flakeScreened: 0,
            name: 'Empty',
            quarantined: 0,
            slug: 'empty',
            staleRate: 0,
          },
        ],
        thresholds: { maxFlakeRate: 0.1, maxStaleRate: 0.2, minKappa: 0.4 },
      });
    });

    it('is ADMIN-only', async () => {
      const { app } = await buildApp('ENGINEER');
      const res = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/platform/evals/suite-health',
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
