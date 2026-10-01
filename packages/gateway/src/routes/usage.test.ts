import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usageRoutes } from './usage.js';

const EMPTY_AGG = {
  _avg: { durationMs: null },
  _count: { _all: 0 },
  _sum: { costUsd: null, inputTokens: null, outputTokens: null },
};

function newMockPrisma() {
  return {
    agentTrace: {
      aggregate: vi.fn().mockResolvedValue(EMPTY_AGG),
      count: vi.fn().mockResolvedValue(0),
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

  it('returns one daily bucket per UTC day of the window, oldest first', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/usage?window=7',
    });

    expect(res.statusCode).toBe(200);
    const { daily, since } = res.json().data;
    expect(daily).toHaveLength(7);
    expect(daily[0].date).toBe(since.slice(0, 10));
    expect(daily[6].date).toBe(new Date().toISOString().slice(0, 10));
    // Only LLM rows are summed — tool calls and activity events carry no cost.
    for (const [args] of prisma.agentTrace.aggregate.mock.calls) {
      expect(args.where.type).toBe('llm_response');
    }
  });

  it('breaks spend down by model with error counts, and ranks the costliest runs', async () => {
    const { app, prisma } = await buildApp();
    prisma.agentTrace.groupBy.mockImplementation(
      async (args: { by: string[]; where: Record<string, unknown>; take?: number }) => {
        const failedOnly = 'error' in args.where;
        if (args.by[0] === 'model') {
          return failedOnly
            ? [{ _count: { _all: 2 }, model: 'anthropic/claude-opus-4-8' }]
            : [
                {
                  _avg: { durationMs: 900 },
                  _count: { _all: 3 },
                  _sum: { costUsd: 0.5, inputTokens: 100, outputTokens: 10 },
                  model: 'openai/text-embedding-3-large',
                },
                {
                  _avg: { durationMs: 4000 },
                  _count: { _all: 10 },
                  _sum: { costUsd: 4.25, inputTokens: 9000, outputTokens: 800 },
                  model: 'anthropic/claude-opus-4-8',
                },
              ];
        }
        if (args.by[0] === 'runId') {
          return [
            { _sum: { costUsd: 3, inputTokens: 5, outputTokens: 1 }, runId: 'run-1' },
            // A run deleted between the two queries is skipped, not rendered empty.
            { _sum: { costUsd: 1, inputTokens: 1, outputTokens: 1 }, runId: 'run-gone' },
          ];
        }
        return [];
      }
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

    const { byModel, topRuns } = res.json().data;
    expect(byModel.map((m: { model: string }) => m.model)).toEqual([
      'anthropic/claude-opus-4-8',
      'openai/text-embedding-3-large',
    ]);
    expect(byModel[0]).toMatchObject({ calls: 10, costUsd: 4.25, errors: 2 });
    expect(byModel[1]).toMatchObject({ errors: 0 });
    expect(topRuns).toEqual([
      expect.objectContaining({ costUsd: 3, externalTicketId: 'JIRA-1', runId: 'run-1' }),
    ]);
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
