import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../index.js';
import { billedOrgId, orgMonthSpend, usdToCents } from './billing.js';

const ORG = 'org-1';

function fakeDb(opts: {
  finalized?: number | null;
  runs?: { id: string; workflowId: string }[];
  ledgers?: { temporalWorkflowId: string; costUsdAccrued: number }[];
  /** Unfinalized runs no connection places in any org (only a ledger repository can). */
  unplaced?: { workflowId: string }[];
  /** Ledger rows whose repository belongs to the org, among the unplaced runs. */
  repoLedgers?: { temporalWorkflowId: string; costUsdAccrued: number }[];
  runTraceCost?: number | null;
  runlessCost?: number | null;
}) {
  const aggregate = vi.fn(async (args: { where: { runId?: unknown } }) => ({
    _sum: {
      costUsd: args.where.runId === null ? (opts.runlessCost ?? null) : (opts.runTraceCost ?? null),
    },
  }));
  const tx = {
    activeWorkflow: {
      findMany: vi.fn(async (args: { where: { repository?: unknown } }) =>
        args.where.repository ? (opts.repoLedgers ?? []) : (opts.ledgers ?? [])
      ),
    },
    agentTrace: { aggregate },
    orgMonthlyUsage: {
      findUnique: vi.fn(async () =>
        opts.finalized == null ? null : { costUsdAccrued: String(opts.finalized) }
      ),
    },
    workflowRun: {
      findMany: vi.fn(async (args: { select: { id?: boolean } }) =>
        args.select.id ? (opts.runs ?? []) : (opts.unplaced ?? [])
      ),
    },
  };
  const $transaction = vi.fn(async (fn: (t: typeof tx) => unknown, _o: unknown) => fn(tx));
  // The same models off the client itself, for the reads outside a transaction.
  const db = { ...tx, $transaction } as unknown as PrismaClient;
  return { $transaction, aggregate, db, tx };
}

describe('orgMonthSpend', () => {
  it('adds in-flight runs (own ledger row, else their traces) and runless spend to the finalized total', async () => {
    const f = fakeDb({
      finalized: 10,
      ledgers: [{ costUsdAccrued: 2.5, temporalWorkflowId: 'wf-a' }],
      runlessCost: 0.75,
      runs: [
        { id: 'run-a', workflowId: 'wf-a' },
        { id: 'run-b', workflowId: 'wf-b' },
      ],
      runTraceCost: 1.25,
    });

    expect(await orgMonthSpend(f.db, ORG)).toEqual({
      finalizedUsd: 10,
      inFlightUsd: 3.75,
      runlessUsd: 0.75,
      totalUsd: 14.5,
    });
    // Only the run without a ledger row is summed from traces, so nothing counts twice.
    expect(f.aggregate).toHaveBeenCalledWith({
      _sum: { costUsd: true },
      where: { runId: { in: ['run-b'] } },
    });
  });

  it('reads every part in one REPEATABLE READ snapshot', async () => {
    const f = fakeDb({});
    await orgMonthSpend(f.db, ORG);
    expect(f.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
  });

  it("selects unfinalized runs billed to the org by endedAt, not status, and runless rows from this month's start", async () => {
    const f = fakeDb({});
    await orgMonthSpend(f.db, ORG);
    // No status predicate: a run the dashboard cancelled keeps `endedAt` null
    // until its workflow finalizes and bills it, so it is counted here until then.
    expect(f.tx.workflowRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          endedAt: null,
          OR: [
            { workRequest: { connection: { team: { orgId: ORG } } } },
            {
              connection: { team: { orgId: ORG } },
              OR: [{ workRequestId: null }, { workRequest: { connectionId: null } }],
            },
          ],
        },
      })
    );
    const runlessWhere = f.aggregate.mock.calls.at(-1)?.[0].where as {
      createdAt: { gte: Date };
      orgId: string;
    };
    expect(runlessWhere.orgId).toBe(ORG);
    expect(runlessWhere.createdAt.gte.toISOString()).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
  });

  it('runs the same reads without the snapshot when the pool cannot start it in time', async () => {
    const f = fakeDb({ finalized: 10, runlessCost: 0.5 });
    f.$transaction.mockRejectedValueOnce(
      Object.assign(new Error('Unable to start a transaction in the given time.'), {
        code: 'P2028',
      })
    );

    expect(await orgMonthSpend(f.db, ORG)).toEqual({
      finalizedUsd: 10,
      inFlightUsd: 0,
      runlessUsd: 0.5,
      totalUsd: 10.5,
    });
    expect(f.tx.workflowRun.findMany).toHaveBeenCalledTimes(2);
  });

  it('rethrows any other failure', async () => {
    const f = fakeDb({});
    f.$transaction.mockRejectedValueOnce(new Error('db down'));
    await expect(orgMonthSpend(f.db, ORG)).rejects.toThrow('db down');
    expect(f.tx.workflowRun.findMany).not.toHaveBeenCalled();
  });

  it('is zero for an org with no spend', async () => {
    expect(await orgMonthSpend(fakeDb({}).db, ORG)).toEqual({
      finalizedUsd: 0,
      inFlightUsd: 0,
      runlessUsd: 0,
      totalUsd: 0,
    });
  });
});

describe('orgMonthSpend: runs placed by the run connection or the ledger', () => {
  it("counts a run with a connection but no work request, via the run's own connection", async () => {
    const f = fakeDb({
      ledgers: [{ costUsdAccrued: 4, temporalWorkflowId: 'wf-sched' }],
      runs: [{ id: 'run-s', workflowId: 'wf-sched' }],
    });
    await orgMonthSpend(f.db, ORG);
    // `workRequest: { connectionId: null }` alone needs the request to exist;
    // `workRequestId: null` is what lets a request-less run through.
    const direct = f.tx.workflowRun.findMany.mock.calls[0]?.[0] as unknown as {
      where: { OR: { OR?: unknown }[] };
    };
    expect(direct.where.OR[1]?.OR).toContainEqual({ workRequestId: null });
    expect((await orgMonthSpend(f.db, ORG)).inFlightUsd).toBe(4);
  });

  it('counts a run only its ledger row places in the org, from that ledger row', async () => {
    const f = fakeDb({
      repoLedgers: [{ costUsdAccrued: 6, temporalWorkflowId: 'wf-bare' }],
      unplaced: [{ workflowId: 'wf-bare' }, { workflowId: 'wf-elsewhere' }],
    });
    const spend = await orgMonthSpend(f.db, ORG);
    expect(spend.inFlightUsd).toBe(6);
    // Unplaced runs name no connection, on the request or on the run; the
    // ledger repository's org decides them.
    expect(f.tx.workflowRun.findMany).toHaveBeenCalledWith({
      select: { workflowId: true },
      where: {
        connectionId: null,
        endedAt: null,
        OR: [{ workRequestId: null }, { workRequest: { connectionId: null } }],
      },
    });
    expect(f.tx.activeWorkflow.findMany).toHaveBeenCalledWith({
      select: { costUsdAccrued: true, temporalWorkflowId: true },
      where: {
        repository: { team: { orgId: ORG } },
        temporalWorkflowId: { in: ['wf-bare', 'wf-elsewhere'] },
      },
    });
  });

  it('asks the ledger nothing when no run is left unplaced', async () => {
    const f = fakeDb({});
    await orgMonthSpend(f.db, ORG);
    expect(f.tx.activeWorkflow.findMany).not.toHaveBeenCalled();
  });
});

describe('billedOrgId', () => {
  it('prefers the request connection, then the run connection only when the request names none, then the ledger', () => {
    const all = { ledgerOrgId: 'L', requestOrgId: 'Q', runOrgId: 'R' };
    expect(billedOrgId({ ...all, requestConnectionId: 'c' })).toBe('Q');
    expect(billedOrgId({ ...all, requestConnectionId: null, requestOrgId: null })).toBe('R');
    expect(billedOrgId({ ledgerOrgId: 'L', runOrgId: 'R' })).toBe('R');
    expect(billedOrgId({ ledgerOrgId: 'L', requestOrgId: null, runOrgId: null })).toBe('L');
    expect(billedOrgId({})).toBeNull();
  });

  it("does not fall back to the run connection when the request's connection has no org", () => {
    // The request named a connection, so it decides; its team having no org
    // sends the run to the ledger, never to the run's own connection.
    expect(
      billedOrgId({
        ledgerOrgId: 'L',
        requestConnectionId: 'c',
        requestOrgId: null,
        runOrgId: 'R',
      })
    ).toBe('L');
    expect(billedOrgId({ requestConnectionId: 'c', requestOrgId: null, runOrgId: 'R' })).toBeNull();
  });
});

describe('usdToCents', () => {
  it('rounds micro-dollar values to whole cents', () => {
    expect(usdToCents(9.9999999e-5)).toBe(0);
    expect(usdToCents(0.099999999)).toBe(10);
    expect(usdToCents(10)).toBe(1000);
  });
});
