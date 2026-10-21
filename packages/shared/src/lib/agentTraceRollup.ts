/**
 * The daily usage rollup: `agent_traces` `llm_response` rows summed per UTC day into
 * `agent_trace_daily_usage`, so the usage report reads a completed day from a few rows instead of
 * scanning its traces. See the Usage paragraph of docs/architecture.md.
 *
 * The rollup is derived data and only ever an optimization: the report falls back to the live
 * traces for any day that has no rollup rows, so a disabled or lagging sweep costs speed, never
 * correctness.
 */
import type { Prisma, PrismaClient } from '../index.js';
import { runUnscoped } from './tenantGuard.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many completed UTC days each sweep rewrites. A trace is stamped with the transaction start
 * (`now()`), so one committed after midnight can still belong to the day before; two days leaves a
 * whole day of margin. The report reads rollups only for days strictly older than this horizon.
 */
export const ROLLUP_RECOMPUTE_DAYS = 2;

/** Rows per `createMany` / ids per `IN` list: far below the 65535 bind-parameter limit. */
const CHUNK = 1000;
/** Scale of `agent_trace_daily_usage.cost_usd`. */
const COST_DECIMALS = 10;
/** One day of a large deployment's groups, written in one transaction. */
export const TX_TIMEOUT_MS = 5 * 60 * 1000;

/** The start of the UTC calendar day containing `ms`. */
export function utcDayStartMs(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/**
 * The first UTC day the report may read from rollups' side of the line: days strictly before this
 * instant are final once their rollup exists; this day and later are always read live.
 */
export function rollupHorizonMs(nowMs: number): number {
  return utcDayStartMs(nowMs) - ROLLUP_RECOMPUTE_DAYS * DAY_MS;
}

/**
 * The launcher a trace's spend belongs to. `WorkflowRun` is upserted by workflow id and never
 * rewritten, so its `launchedById` describes the execution that created the row; a trace from a
 * later execution of the same workflow id (or one that predates `temporalRunId`) is not
 * attributable to it.
 */
export function attributeLauncher(
  run: { launchedById: string | null; temporalRunId: string | null } | undefined,
  traceTemporalRunId: string | null
): string | null {
  return run && traceTemporalRunId !== null && run.temporalRunId === traceTemporalRunId
    ? run.launchedById
    : null;
}

export function chunked<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * `WorkflowRun` launch facts for `runIds`, by run id. `concurrency` chunks are read at a time:
 * a caller on a small connection pool (the gateway's) passes a cap, the sweep reads in sequence.
 */
export async function loadRunLaunchers(
  db: Pick<PrismaClient, 'workflowRun'>,
  runIds: readonly string[],
  concurrency = 1
): Promise<Map<string, { launchedById: string | null; temporalRunId: string | null }>> {
  const byId = new Map<string, { launchedById: string | null; temporalRunId: string | null }>();
  const chunks = chunked([...new Set(runIds)]);
  for (let i = 0; i < chunks.length; i += concurrency) {
    const rows = await Promise.all(
      chunks.slice(i, i + concurrency).map((ids) =>
        db.workflowRun.findMany({
          select: { id: true, launchedById: true, temporalRunId: true },
          where: { id: { in: ids } },
        })
      )
    );
    for (const r of rows.flat()) {
      byId.set(r.id, { launchedById: r.launchedById, temporalRunId: r.temporalRunId });
    }
  }
  return byId;
}

interface DayRow {
  teamId: string | null;
  orgId: string | null;
  runId: string | null;
  agentKey: string;
  model: string | null;
  nodeId: string;
  launcherId: string | null;
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  okDurationMs: number;
  okDurationCount: number;
}

export interface RollupDayResult {
  /** `YYYY-MM-DD`. */
  day: string;
  /** Rollup rows written for the day (0 for a day with no LLM calls). */
  rows: number;
}

/**
 * Recomputes one UTC day: in a single transaction, deletes the day's rollup rows, groups its
 * `llm_response` traces and inserts the groups. Idempotent, and a reader never sees the day half
 * written. No raw SQL: both aggregates are Prisma `groupBy`s.
 *
 * `dayStartMs` must be a UTC midnight.
 */
export async function rollupUsageDay(
  prisma: PrismaClient,
  dayStartMs: number
): Promise<RollupDayResult> {
  if (dayStartMs !== utcDayStartMs(dayStartMs)) {
    throw new Error('rollupUsageDay needs a UTC midnight');
  }
  const day = new Date(dayStartMs);
  const where = {
    createdAt: { gte: day, lt: new Date(dayStartMs + DAY_MS) },
    type: 'llm_response',
  };
  const by = ['teamId', 'orgId', 'runId', 'temporalRunId', 'agentKey', 'model', 'nodeId'] as const;
  type Key = Pick<DayRow, 'teamId' | 'orgId' | 'runId' | 'agentKey' | 'model' | 'nodeId'> & {
    temporalRunId: string | null;
  };
  const keyOf = (g: Key) =>
    JSON.stringify([g.teamId, g.orgId, g.runId, g.temporalRunId, g.agentKey, g.model, g.nodeId]);

  const rows = await runUnscoped(
    'the usage rollup sweep reads and rewrites every tenant’s day',
    ['AgentTrace', 'AgentTraceDailyUsage'],
    () =>
      prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          // Two rewrites of one day (a retried activity beside its slow predecessor, overlapping
          // sweeps) would each delete nothing of the other's uncommitted rows and then both
          // insert, doubling the day. The lock makes the second wait, then delete the first's rows.
          // CLAUDE.md §7 exception: a lock Prisma cannot express; serializes rewrites of one day.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`usage-rollup:${day.toISOString().slice(0, 10)}`}, 0))`;
          const all = await tx.agentTrace.groupBy({
            _count: { _all: true, durationMs: true },
            _sum: { costUsd: true, durationMs: true, inputTokens: true, outputTokens: true },
            by: [...by],
            where,
          });
          const failed = await tx.agentTrace.groupBy({
            _count: { _all: true, durationMs: true },
            _sum: { durationMs: true },
            by: [...by],
            where: { ...where, error: { not: null } },
          });
          const failedByKey = new Map(failed.map((g) => [keyOf(g), g]));
          const launchers = await loadRunLaunchers(
            tx,
            all.flatMap((g) => (g.runId ? [g.runId] : []))
          );

          // Groups differing only in the Temporal run id collapse once it has been resolved to a
          // launcher.
          const merged = new Map<string, DayRow>();
          for (const g of all) {
            const f = failedByKey.get(keyOf(g));
            const launcherId = attributeLauncher(
              g.runId ? launchers.get(g.runId) : undefined,
              g.temporalRunId
            );
            const k = JSON.stringify([
              g.teamId,
              g.orgId,
              g.runId,
              g.agentKey,
              g.model,
              g.nodeId,
              launcherId,
            ]);
            const row = merged.get(k) ?? {
              agentKey: g.agentKey,
              calls: 0,
              costUsd: 0,
              errors: 0,
              inputTokens: 0,
              launcherId,
              model: g.model,
              nodeId: g.nodeId,
              okDurationCount: 0,
              okDurationMs: 0,
              orgId: g.orgId,
              outputTokens: 0,
              runId: g.runId,
              teamId: g.teamId,
            };
            row.calls += g._count._all;
            row.errors += f?._count._all ?? 0;
            row.costUsd += g._sum.costUsd ?? 0;
            row.inputTokens += g._sum.inputTokens ?? 0;
            row.outputTokens += g._sum.outputTokens ?? 0;
            row.okDurationMs += (g._sum.durationMs ?? 0) - (f?._sum.durationMs ?? 0);
            row.okDurationCount += g._count.durationMs - (f?._count.durationMs ?? 0);
            merged.set(k, row);
          }

          await tx.agentTraceDailyUsage.deleteMany({ where: { day } });
          const data = [...merged.values()].map((r) => ({
            ...r,
            // Ten decimals keep the float sum's value to well under a micro-dollar, so the rollup
            // and the live sum agree to floating-point tolerance rather than to a rounding step.
            costUsd: r.costUsd.toFixed(COST_DECIMALS),
            day,
          }));
          for (const batch of chunked(data)) {
            await tx.agentTraceDailyUsage.createMany({ data: batch });
          }
          return data.length;
        },
        { maxWait: 30_000, timeout: TX_TIMEOUT_MS }
      )
  );
  return { day: day.toISOString().slice(0, 10), rows };
}
