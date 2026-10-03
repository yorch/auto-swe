/**
 * Billing helpers shared between the gateway (budget-cap reader) and the worker
 * (OrgMonthlyUsage writer). Keeping the month-bucket formula in one place keeps
 * the writer and reader from silently diverging (e.g. a timezone change), which
 * would make the budget cap stop matching the accrued row.
 */
import type { Prisma, PrismaClient } from '../index.js';
import { runUnscoped } from './tenantGuard.js';

/** Current calendar month as `'YYYY-MM'`, e.g. `'2026-06'` (UTC). */
export function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** An organization's spend this month, in USD, by where it is recorded. */
export interface OrgMonthSpend {
  /** Finalized runs: `OrgMonthlyUsage`, which grows only when a run finalizes. */
  finalizedUsd: number;
  /** Runs still in flight that `finalizeWorkflowRun` will bill to the org. */
  inFlightUsd: number;
  /** Workflows that keep no run, attributed to the org on their trace rows this month. */
  runlessUsd: number;
  totalUsd: number;
}

/**
 * What an organization has spent this month, including what is not billed yet.
 *
 * `OrgMonthlyUsage` only grows when a run finalizes, so a budget gate reading
 * it alone let a burst of long runs spend far past the cap before any of it
 * showed. This adds what finalization will bill: each unfinalized run's own
 * ledger row (or, for a run with none, its trace rows) — billed in whatever
 * month it finalizes, so counted here whenever it started — plus the trace rows
 * of runless workflows attributed to the org, which no finalization ever bills.
 *
 * One snapshot: finalization moves a run's cost from "in flight" to
 * `OrgMonthlyUsage` in a single transaction, and reading both halves under
 * REPEATABLE READ sees it on exactly one side — never both (a false refusal) and
 * never neither. Read-only; it takes no lock. When the pool cannot give the
 * snapshot a connection in time (P2028), the same reads run without it.
 *
 * Mirrors `finalizeWorkflowRun`'s attribution: the work request's connection,
 * else (an epic child, whose request spans repositories) the run's own
 * repository.
 */
export async function orgMonthSpend(db: PrismaClient, orgId: string): Promise<OrgMonthSpend> {
  try {
    return await db.$transaction((tx) => readOrgMonthSpend(tx, orgId), {
      isolationLevel: 'RepeatableRead',
    });
  } catch (err) {
    if (!isTransactionTimeout(err)) {
      throw err;
    }
    // The pool had no connection to hold for the snapshot (or the snapshot
    // outlived its timeout). A budget gate that fails here would refuse every
    // launch whenever the pool is busy, and one that fell back to
    // `OrgMonthlyUsage` alone would forget all in-flight spend; the same reads
    // without the snapshot are only wrong for a run that finalizes during them,
    // which then counts on both sides or neither — off by one run, at worst.
    return readOrgMonthSpend(db, orgId);
  }
}

/** Prisma's P2028: an interactive transaction could not start, or ran past its timeout. */
function isTransactionTimeout(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'P2028';
}

async function readOrgMonthSpend(
  db: Prisma.TransactionClient,
  orgId: string
): Promise<OrgMonthSpend> {
  const yearMonth = currentYearMonth();
  const monthStart = new Date(`${yearMonth}-01T00:00:00.000Z`);
  const usage = await db.orgMonthlyUsage.findUnique({
    select: { costUsdAccrued: true },
    where: { orgId_yearMonth: { orgId, yearMonth } },
  });
  const runs = await db.workflowRun.findMany({
    select: { id: true, workflowId: true },
    where: {
      endedAt: null,
      OR: [
        { workRequest: { connection: { team: { orgId } } } },
        { connection: { team: { orgId } }, workRequest: { connectionId: null } },
      ],
    },
  });
  const ledgers = runs.length
    ? await db.activeWorkflow.findMany({
        select: { costUsdAccrued: true, temporalWorkflowId: true },
        where: { temporalWorkflowId: { in: runs.map((r) => r.workflowId) } },
      })
    : [];
  const withLedger = new Set(ledgers.map((l) => l.temporalWorkflowId));
  const ledgerless = runs.filter((r) => !withLedger.has(r.workflowId)).map((r) => r.id);
  const [traced, runless] = await Promise.all([
    ledgerless.length
      ? runUnscoped('scoped by run ids already filtered to the org', ['AgentTrace'], () =>
          db.agentTrace.aggregate({
            _sum: { costUsd: true },
            where: { runId: { in: ledgerless } },
          })
        )
      : null,
    db.agentTrace.aggregate({
      _sum: { costUsd: true },
      where: { createdAt: { gte: monthStart }, orgId, runId: null },
    }),
  ]);
  const finalizedUsd = Number(usage?.costUsdAccrued ?? 0);
  const inFlightUsd =
    ledgers.reduce((sum, l) => sum + l.costUsdAccrued, 0) + (traced?._sum.costUsd ?? 0);
  const runlessUsd = runless._sum.costUsd ?? 0;
  return {
    finalizedUsd,
    inFlightUsd,
    runlessUsd,
    totalUsd: finalizedUsd + inFlightUsd + runlessUsd,
  };
}

/**
 * USD → whole cents for comparison with a cents cap. Costs carry micro-dollar
 * precision, so a small epsilon keeps values like 9.9999999e-05 rounding right.
 */
export function usdToCents(usd: number): number {
  return Math.round(usd * 100 + 1e-9);
}
