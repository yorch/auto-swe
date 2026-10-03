import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';

/**
 * Platform-wide LLM usage, aggregated from `agent_traces`.
 *
 * Every LLM call and every successful embedding call — run or no run — writes
 * one `llm_response` row carrying its model, tokens, and cost, so those rows
 * are the one place spend is recorded for every workflow. Run-level totals
 * (`WorkflowRun.costUsdAccrued`) miss workflows that keep no run.
 *
 * ADMIN-only: workflows without a run carry no team, so there is nothing to
 * scope their rows by, and the report spans every team.
 */

const WINDOWS = [7, 30, 90] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * The gateway's pg pool holds 10 connections. Four window-wide queries run
 * together, then the per-day aggregates this many at a time, so one report
 * never holds the whole pool against auth and webhook traffic.
 */
const DAILY_CONCURRENCY = 3;
const TOP_RUNS = 10;

const UsageQuery = z.object({
  window: z.coerce
    .number()
    .int()
    .refine((n) => (WINDOWS as readonly number[]).includes(n), {
      message: `window must be one of ${WINDOWS.join(', ')}`,
    })
    .default(30),
});

interface UsageBucket {
  calls: number;
  costUsd: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  /** Mean duration of the calls that succeeded — a timeout is not a latency. */
  avgDurationMs: number | null;
}

/** Running sums a bucket is computed from. */
interface Acc {
  calls: number;
  costUsd: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  okDurationMs: number;
  okDurationCount: number;
}

const emptyAcc = (): Acc => ({
  calls: 0,
  costUsd: 0,
  errors: 0,
  inputTokens: 0,
  okDurationCount: 0,
  okDurationMs: 0,
  outputTokens: 0,
});

function toBucket(a: Acc): UsageBucket {
  return {
    avgDurationMs: a.okDurationCount > 0 ? a.okDurationMs / a.okDurationCount : null,
    calls: a.calls,
    costUsd: a.costUsd,
    errors: a.errors,
    inputTokens: a.inputTokens,
    outputTokens: a.outputTokens,
  };
}

/** Start of the UTC day `ms` falls in. */
function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    })
  );
  return out;
}

/** Why the report's trace queries may span every tenant: the route is ADMIN-only. */
const PLATFORM_WIDE = 'ADMIN usage report spans every tenant';

export const usageRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const prisma = fastify.prisma;

  app.get(
    '/usage',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { querystring: UsageQuery },
    },
    async (request) => {
      const windowDays = request.query.window;
      // Whole UTC days, closed at the end of today, so every query covers
      // exactly the rows the daily bars do — including a request that runs
      // across midnight.
      const until = new Date(utcDayStart(Date.now()) + DAY_MS);
      const since = new Date(until.getTime() - windowDays * DAY_MS);
      const llm = { createdAt: { gte: since, lt: until }, type: 'llm_response' };

      // One grouping by (model, agent, activity) serves the totals and all
      // three breakdowns: the key space is small, and it saves a full-window
      // scan per breakdown.
      const [groups, failedGroups, unattributed, topRunGroups] = await runUnscoped(
        PLATFORM_WIDE,
        ['AgentTrace'],
        () =>
          Promise.all([
            prisma.agentTrace.groupBy({
              _count: { _all: true, durationMs: true },
              _sum: { costUsd: true, durationMs: true, inputTokens: true, outputTokens: true },
              by: ['model', 'agentKey', 'nodeId'],
              where: llm,
            }),
            prisma.agentTrace.groupBy({
              _count: { _all: true, durationMs: true },
              _sum: { durationMs: true },
              by: ['model', 'agentKey', 'nodeId'],
              where: { ...llm, error: { not: null } },
            }),
            prisma.agentTrace.aggregate({
              _count: { _all: true },
              _sum: { costUsd: true },
              where: { ...llm, runId: null },
            }),
            prisma.agentTrace.groupBy({
              _sum: { costUsd: true, inputTokens: true, outputTokens: true },
              by: ['runId'],
              orderBy: { _sum: { costUsd: 'desc' } },
              take: TOP_RUNS,
              where: { ...llm, costUsd: { gt: 0 }, runId: { not: null } },
            }),
          ])
      );

      // JSON keys keep a null model distinct from any real string.
      const keyOf = (g: { model: string | null; agentKey: string; nodeId: string }) =>
        JSON.stringify([g.model, g.agentKey, g.nodeId]);
      const failedByKey = new Map(failedGroups.map((g) => [keyOf(g), g]));

      const totals = emptyAcc();
      const byModel = new Map<string | null, Acc>();
      const byAgent = new Map<string, Acc>();
      const byActivity = new Map<string, Acc>();
      const into = <K>(m: Map<K, Acc>, k: K): Acc => {
        const existing = m.get(k);
        if (existing) {
          return existing;
        }
        const fresh = emptyAcc();
        m.set(k, fresh);
        return fresh;
      };
      for (const g of groups) {
        const failed = failedByKey.get(keyOf(g));
        const errors = failed?._count._all ?? 0;
        const okDurationMs = (g._sum.durationMs ?? 0) - (failed?._sum.durationMs ?? 0);
        const okDurationCount = g._count.durationMs - (failed?._count.durationMs ?? 0);
        for (const a of [
          totals,
          into(byModel, g.model),
          into(byAgent, g.agentKey),
          into(byActivity, g.nodeId),
        ]) {
          a.calls += g._count._all;
          a.costUsd += g._sum.costUsd ?? 0;
          a.errors += errors;
          a.inputTokens += g._sum.inputTokens ?? 0;
          a.outputTokens += g._sum.outputTokens ?? 0;
          a.okDurationMs += okDurationMs;
          a.okDurationCount += okDurationCount;
        }
      }

      const days = Array.from({ length: windowDays }, (_, i) => since.getTime() + i * DAY_MS);
      const daily = await mapLimited(days, DAILY_CONCURRENCY, async (start) => {
        const row = await runUnscoped(PLATFORM_WIDE, ['AgentTrace'], () =>
          prisma.agentTrace.aggregate({
            _count: { _all: true },
            _sum: { costUsd: true, inputTokens: true, outputTokens: true },
            where: {
              createdAt: { gte: new Date(start), lt: new Date(start + DAY_MS) },
              type: 'llm_response',
            },
          })
        );
        return {
          calls: row._count._all,
          costUsd: row._sum.costUsd ?? 0,
          date: new Date(start).toISOString().slice(0, 10),
          inputTokens: row._sum.inputTokens ?? 0,
          outputTokens: row._sum.outputTokens ?? 0,
        };
      });

      const runIds = topRunGroups.flatMap((g) => (g.runId ? [g.runId] : []));
      const runs = runIds.length
        ? await prisma.workflowRun.findMany({
            select: {
              id: true,
              startedAt: true,
              status: true,
              template: { select: { name: true } },
              workRequest: { select: { externalTicketId: true } },
            },
            where: { id: { in: runIds } },
          })
        : [];
      const runById = new Map(runs.map((r) => [r.id, r]));

      const ranked = <K, L extends object>(m: Map<K, Acc>, label: (k: K) => L) =>
        [...m.entries()]
          .map(([k, a]) => ({ ...label(k), ...toBucket(a) }))
          .sort((a, b) => b.costUsd - a.costUsd);

      return {
        data: {
          byActivity: ranked(byActivity, (nodeId) => ({ nodeId })),
          byAgent: ranked(byAgent, (agentKey) => ({ agentKey })),
          // A null model is an LLM call whose spec could not be resolved.
          byModel: ranked(byModel, (model) => ({ model })),
          daily,
          since: since.toISOString(),
          // Ranked by spend inside the window, which for a run that started
          // before it is only part of its cost.
          topRuns: topRunGroups.flatMap((g) => {
            const run = g.runId ? runById.get(g.runId) : undefined;
            if (!run) {
              return [];
            }
            return [
              {
                costUsd: g._sum.costUsd ?? 0,
                externalTicketId: run.workRequest?.externalTicketId ?? null,
                inputTokens: g._sum.inputTokens ?? 0,
                outputTokens: g._sum.outputTokens ?? 0,
                runId: run.id,
                startedAt: run.startedAt,
                status: run.status,
                templateName: run.template.name,
              },
            ];
          }),
          totals: toBucket(totals),
          // Spend from workflows that keep no run: authoring, scheduled evals,
          // lesson consolidation, repo-access sync, epic planning.
          unattributed: {
            calls: unattributed._count._all,
            costUsd: unattributed._sum.costUsd ?? 0,
          },
          until: until.toISOString(),
          windowDays,
        },
      };
    }
  );
};
