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
 * Attributes a run as `billedOrgId` does, which `finalizeRun` and the mid-run
 * cap guard use: the work request's connection, else — only when the request
 * names none — the run's own connection, else — only when the run has no
 * connection either — the run's own ledger row's repository, else the org the
 * request was charged to at launch. The reads below are that rule written as
 * filters.
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

/**
 * The organization a run's spend is billed to, from what each source says.
 * The one definition of the order; `readOrgMonthSpend` below states it as
 * database filters, since it has to find runs rather than resolve one.
 *
 * Each source decides once it exists, with no fall-through to the next: a work
 * request that names a connection decides (its team having no organization
 * bills no one, not the run's connection); when it names none, the run's own
 * connection decides the same way; the ledger row's repository is used only
 * when neither connection exists; and the request's `billingOrgId` — the org a
 * launch with no connection gated the run against — only when there is no
 * ledger repository either. A ledger repository always has an org (a team
 * cannot exist without one), so `ledgerOrgId` is non-null exactly when that
 * repository exists, and a stamped org is never reached past one.
 */
export function billedOrgId(sources: {
  requestConnectionId?: string | null;
  requestOrgId?: string | null;
  runConnectionId?: string | null;
  runOrgId?: string | null;
  ledgerOrgId?: string | null;
  requestBillingOrgId?: string | null;
}): string | null {
  if (sources.requestConnectionId) {
    return sources.requestOrgId ?? null;
  }
  if (sources.runConnectionId) {
    return sources.runOrgId ?? null;
  }
  return sources.ledgerOrgId ?? sources.requestBillingOrgId ?? null;
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
  // Unfinalized by `endedAt`, not status: a dashboard-cancelled run is
  // CANCELLED with `endedAt` null until its workflow finalizes and bills it.
  // `runs` are the runs a connection places in the org; `unplaced` are the
  // unfinalized runs no connection places anywhere, which a ledger row's
  // repository can (the two sets are disjoint); `stamped` are the unplaced runs
  // whose request was charged to this org at launch, which are the org's only
  // when no ledger repository places them (decided below).
  const [runs, unplaced, stamped] = await Promise.all([
    db.workflowRun.findMany({
      select: { id: true, workflowId: true },
      where: {
        endedAt: null,
        OR: [
          { workRequest: { connection: { team: { orgId } } } },
          {
            connection: { team: { orgId } },
            OR: [{ workRequestId: null }, { workRequest: { connectionId: null } }],
          },
        ],
      },
    }),
    db.workflowRun.findMany({
      select: { workflowId: true },
      where: {
        connectionId: null,
        endedAt: null,
        OR: [{ workRequestId: null }, { workRequest: { connectionId: null } }],
      },
    }),
    db.workflowRun.findMany({
      select: { id: true, workflowId: true },
      where: {
        connectionId: null,
        endedAt: null,
        workRequest: { billingOrgId: orgId, connectionId: null },
      },
    }),
  ]);
  const [directLedgers, placedByLedger, stampedLedgers] = await Promise.all([
    runs.length
      ? db.activeWorkflow.findMany({
          select: { costUsdAccrued: true, temporalWorkflowId: true },
          where: { temporalWorkflowId: { in: runs.map((r) => r.workflowId) } },
        })
      : [],
    unplaced.length
      ? db.activeWorkflow.findMany({
          select: { costUsdAccrued: true, temporalWorkflowId: true },
          where: {
            repository: { team: { orgId } },
            temporalWorkflowId: { in: unplaced.map((r) => r.workflowId) },
          },
        })
      : [],
    stamped.length
      ? db.activeWorkflow.findMany({
          select: { costUsdAccrued: true, repoId: true, temporalWorkflowId: true },
          where: { temporalWorkflowId: { in: stamped.map((r) => r.workflowId) } },
        })
      : [],
  ]);
  // A stamped run whose ledger row names a repository is that repository's org's
  // (counted above, by `placedByLedger`, when that is this org) — never this one's
  // through the stamp, so no run is counted on both sides.
  const placedElsewhere = new Set(
    stampedLedgers.filter((l) => l.repoId !== null).map((l) => l.temporalWorkflowId)
  );
  const billedByStamp = stamped.filter((r) => !placedElsewhere.has(r.workflowId));
  const ledgers = [
    ...directLedgers,
    ...placedByLedger,
    ...stampedLedgers.filter((l) => l.repoId === null),
  ];
  const withLedger = new Set(ledgers.map((l) => l.temporalWorkflowId));
  const ledgerless = [...runs, ...billedByStamp]
    .filter((r) => !withLedger.has(r.workflowId))
    .map((r) => r.id);
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

/** A team's spend this month, in USD, by where it is recorded. */
export interface TeamMonthSpend {
  /** Runs finalized this month (UTC) that were attributed to the team. */
  finalizedUsd: number;
  /** Attributed runs still in flight: their ledger row's accrual, else their trace rows. */
  inFlightUsd: number;
  /** Workflows that keep no run, stamped with the team on their trace rows this month. */
  runlessUsd: number;
  totalUsd: number;
}

/**
 * What a team has spent this month, including what is not finalized yet.
 *
 * **One attribution rule.** A run belongs to `WorkflowRun.attributedTeamId`, written when the run
 * is created by `resolveWorkflowRunAttribution`: the team that OWNS the run's repository, and only
 * for a run with no repository the channel's, the service principal's or the template's team. A
 * repository shared to another team therefore spends the OWNER's budget, never the sharee's, and
 * a run is counted for exactly one team. The launch gate asks the same question of the same owner
 * (`decideTeamBudgets`), so a launch is refused against the team whose spend it will add to.
 * A run with no attribution (rows that predate the column, a run no team is derivable for) counts
 * against no team.
 *
 * Unlike an organization, a team has no ledger table: finalized spend is read from the finalized
 * runs themselves (`costUsdAccrued`, set in the same transaction as `endedAt`), and a run is
 * finalized in the month its `endedAt` falls in, as `OrgMonthlyUsage` bills it. Read under one
 * REPEATABLE READ snapshot, a finalizing run is on exactly one side — in flight (`endedAt` null)
 * or finalized — so it is never counted twice and never missed. When the pool cannot give the
 * snapshot a connection in time (P2028), the same reads run without it. Read-only; no lock.
 */
export async function teamMonthSpend(db: PrismaClient, teamId: string): Promise<TeamMonthSpend> {
  try {
    return await db.$transaction((tx) => readTeamMonthSpend(tx, teamId), {
      isolationLevel: 'RepeatableRead',
    });
  } catch (err) {
    if (!isTransactionTimeout(err)) {
      throw err;
    }
    return readTeamMonthSpend(db, teamId);
  }
}

async function readTeamMonthSpend(
  db: Prisma.TransactionClient,
  teamId: string
): Promise<TeamMonthSpend> {
  const monthStart = new Date(`${currentYearMonth()}-01T00:00:00.000Z`);
  const [finalized, inFlightRuns, runless] = await Promise.all([
    db.workflowRun.aggregate({
      _sum: { costUsdAccrued: true },
      where: { attributedTeamId: teamId, endedAt: { gte: monthStart } },
    }),
    db.workflowRun.findMany({
      select: { id: true, workflowId: true },
      where: { attributedTeamId: teamId, endedAt: null },
    }),
    db.agentTrace.aggregate({
      _sum: { costUsd: true },
      where: { createdAt: { gte: monthStart }, runId: null, teamId },
    }),
  ]);
  const ledgers = inFlightRuns.length
    ? await db.activeWorkflow.findMany({
        select: { costUsdAccrued: true, temporalWorkflowId: true },
        where: { temporalWorkflowId: { in: inFlightRuns.map((r) => r.workflowId) } },
      })
    : [];
  const withLedger = new Set(ledgers.map((l) => l.temporalWorkflowId));
  const ledgerless = inFlightRuns.filter((r) => !withLedger.has(r.workflowId)).map((r) => r.id);
  const traced = ledgerless.length
    ? await runUnscoped('scoped by run ids already filtered to the team', ['AgentTrace'], () =>
        db.agentTrace.aggregate({ _sum: { costUsd: true }, where: { runId: { in: ledgerless } } })
      )
    : null;
  const finalizedUsd = finalized._sum.costUsdAccrued ?? 0;
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
 * Has `teamId` spent its monthly cap? `false` when it sets none. Best-effort under concurrency,
 * exactly like the organization's cap: spend is recorded after a launch returns, so two launches
 * that arrive together read the same total and a running run can spend past the cap. A zero cap
 * is reached by any spend, including none, so it refuses every launch.
 */
export async function isTeamOverBudget(
  db: PrismaClient,
  teamId: string,
  capCents: number | null | undefined
): Promise<boolean> {
  if (capCents == null) {
    return false;
  }
  return usdToCents((await teamMonthSpend(db, teamId)).totalUsd) >= capCents;
}

/**
 * USD → whole cents for comparison with a cents cap. Costs carry micro-dollar
 * precision, so a small epsilon keeps values like 9.9999999e-05 rounding right.
 */
export function usdToCents(usd: number): number {
  return Math.round(usd * 100 + 1e-9);
}
