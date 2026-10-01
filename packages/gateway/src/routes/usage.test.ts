import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usageRoutes } from './usage.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const EMPTY_AGG = {
  _count: { _all: 0 },
  _sum: { costUsd: null, inputTokens: null, outputTokens: null },
};

function newMockPrisma() {
  return {
    agentTrace: {
      aggregate: vi.fn().mockResolvedValue(EMPTY_AGG),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    workflowRun: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

async function buildApp(role: 'ADMIN' | 'LEAD' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = newMockPrisma();
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'admin-1' }),
  } as unknown as never);
  await app.register(usageRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  return { app, prisma };
}

const AUTH = { authorization: 'Bearer fake' };

/** One (model, agent, activity) group as Prisma returns it. */
function group(
  model: string | null,
  agentKey: string,
  nodeId: string,
  calls: number,
  costUsd: number,
  durationMs: number
) {
  return {
    _count: { _all: calls, durationMs: calls },
    _sum: { costUsd, durationMs, inputTokens: calls * 100, outputTokens: calls * 10 },
    agentKey,
    model,
    nodeId,
  };
}

type GroupByArgs = { by: string[]; where: Record<string, unknown> };

beforeEach(() => vi.clearAllMocks());

describe('usageRoutes GET /usage', () => {
  it('rejects non-admins: runless traces carry no team to scope by', async () => {
    const { app } = await buildApp('LEAD');
    const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/platform/usage' });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a window outside 7/30/90', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/usage?window=365',
    });
    expect(res.statusCode).toBe(400);
  });

  it('bounds every query by the same whole-UTC-day window the bars cover', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/usage?window=7',
    });

    expect(res.statusCode).toBe(200);
    const { daily, since, until } = res.json().data;
    const sinceMs = Date.parse(since);
    const untilMs = Date.parse(until);
    expect(untilMs - sinceMs).toBe(7 * DAY_MS);
    expect(sinceMs % DAY_MS).toBe(0);
    expect(daily.map((d: { date: string }) => d.date)).toEqual(
      Array.from({ length: 7 }, (_, i) => new Date(sinceMs + i * DAY_MS).toISOString().slice(0, 10))
    );
    // Window-wide queries share the bars' upper bound, so totals == sum(bars).
    for (const [args] of prisma.agentTrace.groupBy.mock.calls) {
      expect(args.where.createdAt).toEqual({ gte: new Date(sinceMs), lt: new Date(untilMs) });
      expect(args.where.type).toBe('llm_response');
    }
    const dayBounds = prisma.agentTrace.aggregate.mock.calls
      .map(([args]) => args.where)
      .filter((w) => w.runId === undefined)
      .map((w) => [w.createdAt.gte.getTime(), w.createdAt.lt.getTime()]);
    expect(dayBounds).toEqual(
      Array.from({ length: 7 }, (_, i) => [sinceMs + i * DAY_MS, sinceMs + (i + 1) * DAY_MS])
    );
  });

  it('rolls one grouping up into totals and per-model, per-agent, per-activity breakdowns', async () => {
    const { app, prisma } = await buildApp();
    prisma.agentTrace.groupBy.mockImplementation(async (args: GroupByArgs) => {
      if (args.by[0] === 'runId') {
        return [];
      }
      if ('error' in args.where) {
        // One of the implementer's calls failed after 30 s.
        return [
          {
            ...group(
              'anthropic/claude-opus-4-8',
              'implementer',
              'executeImplementation',
              1,
              0,
              30_000
            ),
          },
        ];
      }
      return [
        group('anthropic/claude-opus-4-8', 'implementer', 'executeImplementation', 3, 4, 36_000),
        group('anthropic/claude-opus-4-8', 'reviewer', 'runReviewNetwork', 1, 1, 2_000),
        group('openai/text-embedding-3-large', 'embedding', 'executeImplementation', 2, 0.5, 100),
        // Same agent and activity, unresolved model: must not merge with any real model.
        group(null, 'implementer', 'executeImplementation', 1, 0, 1_000),
      ];
    });

    const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/platform/usage' });
    const { byActivity, byAgent, byModel, totals } = res.json().data;

    expect(totals).toMatchObject({ calls: 7, costUsd: 5.5, errors: 1 });
    expect(byModel.map((m: { model: string | null }) => m.model)).toEqual([
      'anthropic/claude-opus-4-8',
      'openai/text-embedding-3-large',
      null,
    ]);
    // The 30 s failure is excluded from latency: (36 000 - 30 000 + 2 000) / 3 successes.
    expect(byModel[0]).toMatchObject({ avgDurationMs: 8_000 / 3, calls: 4, errors: 1 });
    expect(byAgent.find((a: { agentKey: string }) => a.agentKey === 'implementer')).toMatchObject({
      calls: 4,
      errors: 1,
    });
    expect(byActivity[0]).toMatchObject({ calls: 6, nodeId: 'executeImplementation' });
  });

  it('ranks the costliest runs and skips one deleted between queries', async () => {
    const { app, prisma } = await buildApp();
    prisma.agentTrace.groupBy.mockImplementation(async (args: GroupByArgs) =>
      args.by[0] === 'runId'
        ? [
            { _sum: { costUsd: 3, inputTokens: 5, outputTokens: 1 }, runId: 'run-1' },
            { _sum: { costUsd: 1, inputTokens: 1, outputTokens: 1 }, runId: 'run-gone' },
          ]
        : []
    );
    prisma.workflowRun.findMany.mockResolvedValue([
      {
        id: 'run-1',
        startedAt: new Date('2026-09-01T00:00:00Z'),
        status: 'SUCCESS',
        template: { name: 'Ticket to PR' },
        workRequest: { externalTicketId: 'JIRA-1' },
      },
    ]);

    const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/platform/usage' });

    expect(res.json().data.topRuns).toEqual([
      expect.objectContaining({ costUsd: 3, externalTicketId: 'JIRA-1', runId: 'run-1' }),
    ]);
    const topCall = prisma.agentTrace.groupBy.mock.calls.find(([a]) => a.by[0] === 'runId')?.[0];
    expect(topCall).toMatchObject({
      orderBy: { _sum: { costUsd: 'desc' } },
      take: 10,
      where: { costUsd: { gt: 0 }, runId: { not: null } },
    });
  });

  it('reports spend from workflows that keep no run separately', async () => {
    const { app, prisma } = await buildApp();
    prisma.agentTrace.aggregate.mockImplementation(async (args: { where: { runId?: unknown } }) =>
      args.where.runId === null ? { _count: { _all: 4 }, _sum: { costUsd: 0.75 } } : EMPTY_AGG
    );

    const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/platform/usage' });

    expect(res.json().data.unattributed).toEqual({ calls: 4, costUsd: 0.75 });
  });
});
