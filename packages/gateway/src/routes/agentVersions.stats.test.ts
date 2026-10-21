import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/skillScanner', () => ({
  scanSkillContent: vi.fn(async () => ({ safe: true, warnings: [] })),
}));

import { agentVersionRoutes } from './agentVersions.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ID = '00000000-0000-4000-8000-000000000001';
const V1 = '00000000-0000-4000-8000-0000000000a1';
const V2 = '00000000-0000-4000-8000-0000000000a2';
const URL = `/api/v1/platform/agent-library/${ID}/version-stats`;

const lineage = [
  { id: V2, scope: 'GLOBAL', version: 2 },
  { id: V1, scope: 'GLOBAL', version: 1 },
];

const liveTotals = (over: Record<string, unknown> = {}) => ({
  _count: { _all: 10, durationMs: 10 },
  _sum: { costUsd: 1.5, durationMs: 5000, inputTokens: 1000, outputTokens: 200 },
  agentId: V2,
  model: 'anthropic/a',
  ...over,
});

function newMockPrisma() {
  const prisma = {
    agent: {
      findMany: vi.fn().mockResolvedValue(lineage),
      findUnique: vi.fn().mockResolvedValue({
        channelId: null,
        id: ID,
        key: 'reviewer',
        orgId: null,
        scope: 'GLOBAL',
        teamId: null,
        workflowTemplateId: null,
      }),
    },
    agentTrace: { groupBy: vi.fn() },
    agentTraceDailyUsage: { groupBy: vi.fn() },
  };
  // Live traces for every day (no rollup coverage) unless a test says otherwise.
  prisma.agentTraceDailyUsage.groupBy.mockResolvedValue([]);
  prisma.agentTrace.groupBy.mockImplementation(async (args: { by: string[]; where: unknown }) => {
    if (args.by.includes('runId')) {
      return [];
    }
    return JSON.stringify(args.where).includes('"error"') ? [] : [liveTotals()];
  });
  return prisma;
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
  await app.register(agentVersionRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  return { app, prisma };
}

const AUTH = { authorization: 'Bearer fake' };
const get = (app: Awaited<ReturnType<typeof buildApp>>['app'], query = '') =>
  app.inject({ headers: AUTH, method: 'GET', url: `${URL}${query}` });

beforeEach(() => vi.clearAllMocks());

describe('GET /agent-library/:id/version-stats', () => {
  it('is ADMIN-only', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    expect((await get(app)).statusCode).toBe(403);
    expect(prisma.agentTrace.groupBy).not.toHaveBeenCalled();
  });

  it('404s for an unknown agent', async () => {
    const { app, prisma } = await buildApp();
    prisma.agent.findUnique.mockResolvedValue(null);
    expect((await get(app)).statusCode).toBe(404);
  });

  it('rejects a window outside the presets and a half-open custom range', async () => {
    const { app } = await buildApp();
    expect((await get(app, '?window=5')).statusCode).toBe(400);
    expect((await get(app, '?since=2026-01-01')).statusCode).toBe(400);
  });

  it('selects the traces of the whole lineage by agent id, plus this key’s unrecorded ones', async () => {
    const { app, prisma } = await buildApp();
    await get(app);
    // The lineage pins every scope key, as the version history does.
    expect(prisma.agent.findMany.mock.calls[0]?.[0].where).toMatchObject({
      channelId: null,
      key: 'reviewer',
      scope: 'GLOBAL',
    });
    const where = JSON.stringify(prisma.agentTrace.groupBy.mock.calls[0]?.[0].where);
    expect(where).toContain(V1);
    expect(where).toContain(V2);
    expect(where).toContain('"agentId":null,"agentKey":"reviewer"');
    expect(where).toContain('llm_response');
  });

  it('groups by agent id and model, carrying the version and scope of the lineage row', async () => {
    const { app, prisma } = await buildApp();
    prisma.agentTrace.groupBy.mockImplementation(async (args: { by: string[]; where: unknown }) => {
      const failed = JSON.stringify(args.where).includes('"error"');
      if (args.by.includes('runId')) {
        return [
          { agentId: V2, model: 'anthropic/a', runId: 'r1' },
          { agentId: V2, model: 'anthropic/a', runId: 'r2' },
          { agentId: V1, model: 'anthropic/a', runId: 'r1' },
        ];
      }
      if (failed) {
        return [
          {
            _count: { _all: 2, durationMs: 2 },
            _sum: { durationMs: 1000 },
            agentId: V2,
            model: 'anthropic/a',
          },
        ];
      }
      return [
        liveTotals(),
        liveTotals({ _count: { _all: 1, durationMs: 1 }, model: 'anthropic/b' }),
        liveTotals({ agentId: V1 }),
      ];
    });
    const res = await get(app);
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(
      data.rows.map((r: { agentVersion: number; model: string }) => [r.agentVersion, r.model])
    ).toEqual([
      [2, 'anthropic/a'],
      [2, 'anthropic/b'],
      [1, 'anthropic/a'],
    ]);
    const v2a = data.rows[0];
    expect(v2a).toMatchObject({
      agentId: V2,
      calls: 10,
      costUsd: 1.5,
      distinctRuns: 2,
      errors: 2,
      inputTokens: 1000,
      outputTokens: 200,
      scope: 'GLOBAL',
    });
    // Mean latency leaves the two failed calls (1000 ms) out: (5000 - 1000) / (10 - 2).
    expect(v2a.avgDurationMs).toBe(500);
    expect(data.isTruncated).toBe(false);
  });

  it('returns the calls that name no agent as an unrecorded bucket, apart from the versions', async () => {
    const { app, prisma } = await buildApp();
    prisma.agentTrace.groupBy.mockImplementation(async (args: { by: string[]; where: unknown }) => {
      if (args.by.includes('runId') || JSON.stringify(args.where).includes('"error"')) {
        return [];
      }
      return [liveTotals(), liveTotals({ agentId: null, model: 'anthropic/old' })];
    });
    const { data } = (await get(app)).json();
    expect(data.rows).toHaveLength(1);
    expect(data.unrecorded).toHaveLength(1);
    expect(data.unrecorded[0]).toMatchObject({
      agentId: null,
      agentVersion: null,
      model: 'anthropic/old',
      scope: null,
    });
  });

  it('reads settled days from the rollup and recent days live, and sums the two', async () => {
    const { app, prisma } = await buildApp();
    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    prisma.agentTraceDailyUsage.groupBy.mockImplementation(async (args: { by: string[] }) => {
      if (args.by.length === 1 && args.by[0] === 'day') {
        return Array.from({ length: 60 }, (_, k) => ({ day: new Date(today - k * DAY_MS) }));
      }
      if (args.by.includes('runId')) {
        return [
          { agentId: V2, model: 'anthropic/a', runId: 'r2' },
          { agentId: V2, model: 'anthropic/a', runId: 'r9' },
        ];
      }
      return [
        {
          _sum: {
            calls: 100,
            costUsd: { toNumber: () => 4 },
            errors: 5,
            inputTokens: 9000n,
            okDurationCount: 95,
            okDurationMs: 9500,
            outputTokens: 800n,
          },
          agentId: V2,
          model: 'anthropic/a',
        },
      ];
    });
    prisma.agentTrace.groupBy.mockImplementation(async (args: { by: string[]; where: unknown }) => {
      if (args.by.includes('runId')) {
        return [{ agentId: V2, model: 'anthropic/a', runId: 'r2' }];
      }
      return JSON.stringify(args.where).includes('"error"') ? [] : [liveTotals()];
    });
    const { data } = (await get(app)).json();
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({
      calls: 110,
      costUsd: 5.5,
      // r2 is in both sources and counts once.
      distinctRuns: 2,
      errors: 5,
      inputTokens: 10_000,
    });
    // (9500 + 5000) ms over (95 + 10) ok calls.
    expect(data.rows[0].avgDurationMs).toBeCloseTo(14_500 / 105);
    // Live traces are read for the recent days only: three queries (totals, failed, runs), each
    // bounded to a time range that starts after the rollup horizon.
    expect(prisma.agentTrace.groupBy).toHaveBeenCalledTimes(3);
    const horizon = today - 2 * DAY_MS;
    for (const [args] of prisma.agentTrace.groupBy.mock.calls) {
      const gtes = [...JSON.stringify(args.where).matchAll(/"gte":"([^"]+)"/g)].map((m) =>
        Date.parse(m[1] as string)
      );
      expect(gtes.length).toBeGreaterThan(0);
      for (const g of gtes) {
        expect(g).toBeGreaterThanOrEqual(horizon);
      }
    }
    // Rollup: the covered-days lookup, then totals and runs.
    expect(prisma.agentTraceDailyUsage.groupBy).toHaveBeenCalledTimes(3);
    expect(prisma.agentTraceDailyUsage.groupBy.mock.calls.map(([a]) => a.by.join(','))).toEqual([
      'day',
      'agentId,model',
      'agentId,model,runId',
    ]);
  });

  it('flags a read that hit its cap and drops the overflow row', async () => {
    const { app, prisma } = await buildApp();
    prisma.agentTrace.groupBy.mockImplementation(async (args: { by: string[]; where: unknown }) => {
      if (args.by.includes('runId') || JSON.stringify(args.where).includes('"error"')) {
        return [];
      }
      return Array.from({ length: 2001 }, (_, i) => liveTotals({ model: `m/${i}` }));
    });
    const { data } = (await get(app)).json();
    expect(data.isTruncated).toBe(true);
    expect(data.groupsTruncated).toBe(true);
    expect(data.runsTruncated).toBe(false);
    expect(data.rows).toHaveLength(2000);
  });

  it('reports a run-list cap on its own, leaving the call totals complete', async () => {
    const { app, prisma } = await buildApp();
    prisma.agentTrace.groupBy.mockImplementation(async (args: { by: string[]; where: unknown }) => {
      if (args.by.includes('runId')) {
        return Array.from({ length: 20_001 }, (_, i) => ({
          agentId: V2,
          model: 'anthropic/a',
          runId: `r${i}`,
        }));
      }
      return JSON.stringify(args.where).includes('"error"') ? [] : [liveTotals()];
    });
    const { data } = (await get(app)).json();
    expect(data).toMatchObject({ groupsTruncated: false, isTruncated: true, runsTruncated: true });
    expect(data.rows[0].distinctRuns).toBe(20_000);
  });

  it('orders NULL agent ids first, so a cap cuts versions and never the unrecorded bucket', async () => {
    const { app, prisma } = await buildApp();
    prisma.agentTrace.groupBy.mockImplementation(async (args: { by: string[]; where: unknown }) => {
      if (args.by.includes('runId') || JSON.stringify(args.where).includes('"error"')) {
        return [];
      }
      // As the ordering returns them: the unrecorded group first, then 2000 version groups.
      return [
        liveTotals({ agentId: null, model: 'anthropic/old' }),
        ...Array.from({ length: 2000 }, (_, i) => liveTotals({ model: `m/${i}` })),
      ];
    });
    const { data } = (await get(app)).json();
    expect(prisma.agentTrace.groupBy.mock.calls[0]?.[0].orderBy[0]).toEqual({
      agentId: { nulls: 'first', sort: 'asc' },
    });
    expect(data.isTruncated).toBe(true);
    expect(data.unrecorded).toHaveLength(1);
    expect(data.rows.length + data.unrecorded.length).toBe(2000);
  });

  it('never runs more than three queries together', async () => {
    const { app, prisma } = await buildApp();
    let inFlight = 0;
    let peak = 0;
    const slow = (rows: unknown[]) => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return rows;
    };
    prisma.agentTrace.groupBy.mockImplementation(slow([]));
    prisma.agentTraceDailyUsage.groupBy.mockImplementation(slow([]));
    await get(app);
    expect(peak).toBeLessThanOrEqual(3);
  });
});
