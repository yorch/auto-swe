import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';

/**
 * Platform-wide LLM usage, aggregated from `agent_traces`.
 *
 * Every LLM call — chat or embedding, run or no run — writes one
 * `llm_response` row carrying its model, tokens, and cost, so those rows are
 * the one place spend is recorded for every workflow. Run-level totals
 * (`WorkflowRun.costUsdAccrued`) miss workflows that keep no run.
 *
 * ADMIN-only: workflows without a run carry no team, so there is nothing to
 * scope their rows by, and the report spans every team.
 */

const WINDOWS = [7, 30, 90] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Daily totals run as one aggregate per day; bound how many hit the pool at once. */
const DAILY_CONCURRENCY = 6;
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
  avgDurationMs: number | null;
}

type GroupRow = {
  _count: { _all: number };
  _sum: { costUsd: number | null; inputTokens: number | null; outputTokens: number | null };
  _avg: { durationMs: number | null };
};

function bucket(row: GroupRow | undefined, errors: number): UsageBucket {
  return {
    avgDurationMs: row?._avg.durationMs ?? null,
    calls: row?._count._all ?? 0,
    costUsd: row?._sum.costUsd ?? 0,
    errors,
    inputTokens: row?._sum.inputTokens ?? 0,
    outputTokens: row?._sum.outputTokens ?? 0,
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
      // Whole UTC days, so the first bar is not a partial day.
      const now = Date.now();
      const since = new Date(utcDayStart(now) - (windowDays - 1) * DAY_MS);
      const llm = { createdAt: { gte: since }, type: 'llm_response' };
      const failed = { ...llm, error: { not: null } };
      const sums = { costUsd: true, inputTokens: true, outputTokens: true } as const;
      const groupAggs = { _avg: { durationMs: true }, _count: { _all: true }, _sum: sums } as const;

      const [
        totals,
        totalErrors,
        unattributed,
        byModel,
        byModelErrors,
        byAgent,
        byAgentErrors,
        byActivity,
        byActivityErrors,
        topRunGroups,
      ] = await Promise.all([
        prisma.agentTrace.aggregate({ ...groupAggs, where: llm }),
        prisma.agentTrace.count({ where: failed }),
        prisma.agentTrace.aggregate({
          _count: { _all: true },
          _sum: { costUsd: true },
          where: { ...llm, runId: null },
        }),
        prisma.agentTrace.groupBy({ ...groupAggs, by: ['model'], where: llm }),
        prisma.agentTrace.groupBy({ _count: { _all: true }, by: ['model'], where: failed }),
        prisma.agentTrace.groupBy({ ...groupAggs, by: ['agentKey'], where: llm }),
        prisma.agentTrace.groupBy({ _count: { _all: true }, by: ['agentKey'], where: failed }),
        prisma.agentTrace.groupBy({ ...groupAggs, by: ['nodeId'], where: llm }),
        prisma.agentTrace.groupBy({ _count: { _all: true }, by: ['nodeId'], where: failed }),
        prisma.agentTrace.groupBy({
          _sum: sums,
          by: ['runId'],
          orderBy: { _sum: { costUsd: 'desc' } },
          take: TOP_RUNS,
          where: { ...llm, costUsd: { gt: 0 }, runId: { not: null } },
        }),
      ]);

      const days = Array.from({ length: windowDays }, (_, i) => since.getTime() + i * DAY_MS);
      const daily = await mapLimited(days, DAILY_CONCURRENCY, async (start) => {
        const row = await prisma.agentTrace.aggregate({
          _count: { _all: true },
          _sum: sums,
          where: {
            createdAt: { gte: new Date(start), lt: new Date(start + DAY_MS) },
            type: 'llm_response',
          },
        });
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

      const errorsBy = <K extends string>(
        rows: Array<Record<K, string | null> & { _count: { _all: number } }>,
        key: K
      ) => new Map(rows.map((r) => [r[key] ?? '', r._count._all]));
      const modelErrors = errorsBy(byModelErrors, 'model');
      const agentErrors = errorsBy(byAgentErrors, 'agentKey');
      const activityErrors = errorsBy(byActivityErrors, 'nodeId');

      const byCost = (a: { costUsd: number }, b: { costUsd: number }) => b.costUsd - a.costUsd;

      return {
        data: {
          byActivity: byActivity
            .map((r) => ({ nodeId: r.nodeId, ...bucket(r, activityErrors.get(r.nodeId) ?? 0) }))
            .sort(byCost),
          byAgent: byAgent
            .map((r) => ({ agentKey: r.agentKey, ...bucket(r, agentErrors.get(r.agentKey) ?? 0) }))
            .sort(byCost),
          // A null model is an LLM call whose spec could not be resolved.
          byModel: byModel
            .map((r) => ({ model: r.model, ...bucket(r, modelErrors.get(r.model ?? '') ?? 0) }))
            .sort(byCost),
          daily,
          since: since.toISOString(),
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
          totals: bucket(totals, totalErrors),
          // Spend from workflows that keep no run: authoring, scheduled evals,
          // lesson consolidation, repo-access sync, epic planning.
          unattributed: {
            calls: unattributed._count._all,
            costUsd: unattributed._sum.costUsd ?? 0,
          },
          windowDays,
        },
      };
    }
  );
};
