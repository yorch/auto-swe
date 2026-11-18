import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PLAN_RETENTION_MS,
  EXPIRE_BATCH,
  expireRunPlans,
  SCRUB_BATCH,
  SCRUBBED_HASH,
} from './runPlanSweep.js';

const NOW = new Date('2026-11-17T12:00:00Z');

function fake(due: string[], stillExpired: string[], deleted = 0) {
  return {
    runPlan: {
      deleteMany: vi.fn(async (_args: unknown) => ({ count: deleted })),
      findMany: vi
        .fn()
        .mockResolvedValueOnce(due.map((id) => ({ id })))
        .mockResolvedValueOnce(stillExpired.map((id) => ({ id })))
        .mockResolvedValue([]),
      groupBy: vi.fn(async (_args: unknown) => []),
      updateMany: vi.fn(async (_args: unknown) => ({ count: due.length })),
    },
  };
}

describe('expireRunPlans', () => {
  it('expires the due plans by id and reports only the ones that are now EXPIRED', async () => {
    // p2 was approved (its expiry extended) between the read and the write.
    const prisma = fake(['p1', 'p2'], ['p1'], 3);
    const result = await expireRunPlans(prisma as never, NOW);
    expect(result).toEqual({ deleted: 3, expired: 1, expiredIds: ['p1'], scrubbed: [] });
    expect(prisma.runPlan.updateMany).toHaveBeenCalledWith({
      data: { status: 'EXPIRED' },
      where: {
        expiresAt: { lte: NOW },
        id: { in: ['p1', 'p2'] },
        status: { in: ['PENDING', 'APPROVED'] },
      },
    });
    expect(prisma.runPlan.findMany.mock.calls[0]?.[0]).toMatchObject({ take: EXPIRE_BATCH });
  });

  it('deletes expired and rejected plans past retention, and never names LAUNCHED', async () => {
    const prisma = fake([], []);
    await expireRunPlans(prisma as never, NOW);
    expect(prisma.runPlan.updateMany).not.toHaveBeenCalled();
    expect(prisma.runPlan.deleteMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: new Date(NOW.getTime() - DEFAULT_PLAN_RETENTION_MS) },
        status: { in: ['EXPIRED', 'REJECTED'] },
      },
    });
    // The delete never names LAUNCHED (the scrub's own reads do).
    expect(JSON.stringify(prisma.runPlan.deleteMany.mock.calls)).not.toContain('LAUNCHED');
  });
});

const DAY = 24 * 3_600_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

interface Where {
  status?: string | { in: string[] };
  id?: string;
  teamId?: string;
  scrubbedAt?: null | Date;
  approvedAt?: { lt?: Date };
  expiresAt?: unknown;
}
interface Args {
  where: Where;
  take?: number;
  data?: Partial<Row>;
}

interface Row {
  id: string;
  teamId: string;
  orgId: string;
  mode: string;
  status: string;
  approvedAt: Date;
  scrubbedAt: Date | null;
  intent: string;
  spec: unknown;
  routerCandidates: unknown;
  skeletonReport: unknown;
  validationReport: unknown;
  costEstimate: unknown;
  specHash: string;
  catalogHash: string;
  agentPins: unknown;
}

function row(id: string, over: Partial<Row> = {}): Row {
  return {
    agentPins: { implementer: 3 },
    approvedAt: daysAgo(100),
    catalogHash: 'c',
    costEstimate: {
      exclusions: 'leaves out retries of node-secret',
      fanOutWidthAssumed: 3,
      perStep: [{ nodeId: 'node-secret', step: 'x', usd: 1 }],
      totalUsd: 1.25,
      unpriced: [{ nodeId: 'node-secret', reason: 'no-cost-hint' }],
    },
    id,
    intent: 'rotate the payroll keys',
    mode: 'delivering',
    orgId: 'o1',
    routerCandidates: { intentHash: 'h', summary: 'secret summary' },
    scrubbedAt: null,
    skeletonReport: { regions: { core: ['node-secret'] } },
    spec: { nodes: { 'node-secret': {} } },
    specHash: 'sh',
    status: 'LAUNCHED',
    teamId: 't1',
    validationReport: { warnings: [{ message: 'quotes the goal' }] },
    ...over,
  };
}

/** An in-memory run_plans table that honours the predicates the sweep sends. */
function table(rows: Row[]) {
  const matches = (r: Row, w: Where): boolean =>
    (w.status === undefined ||
      (typeof w.status === 'string' ? r.status === w.status : w.status.in.includes(r.status))) &&
    (w.id === undefined || r.id === w.id) &&
    (w.teamId === undefined || r.teamId === w.teamId) &&
    (w.scrubbedAt === undefined || (w.scrubbedAt === null ? r.scrubbedAt === null : true)) &&
    (w.approvedAt?.lt === undefined || r.approvedAt < w.approvedAt.lt) &&
    (w.expiresAt === undefined || false);
  return {
    rows,
    runPlan: {
      deleteMany: vi.fn(async (_args: unknown) => ({ count: 0 })),
      findMany: vi.fn(async (args: Args) => {
        const hit = rows.filter((r) => matches(r, args.where));
        return hit
          .sort((a, b) => a.approvedAt.getTime() - b.approvedAt.getTime())
          .slice(0, args.take ?? 1000)
          .map((r) => ({ costEstimate: r.costEstimate, id: r.id, mode: r.mode }));
      }),
      groupBy: vi.fn(async (args: Args) => {
        const teams = [...new Set(rows.filter((r) => matches(r, args.where)).map((r) => r.teamId))];
        return teams.sort().map((teamId) => ({ teamId }));
      }),
      updateMany: vi.fn(async (args: Args) => {
        const hit = rows.filter((r) => matches(r, args.where));
        for (const r of hit) {
          Object.assign(r, args.data);
        }
        return { count: hit.length };
      }),
    },
    team: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in.map((id) => ({
          id,
          orgId: rows.find((r) => r.teamId === id)?.orgId ?? 'o1',
        }))
      ),
    },
  };
}

describe('expireRunPlans: scrubbing launched plans', () => {
  const retention = (byTeam: Record<string, number>) =>
    vi.fn(async (scope: { teamId: string }) => byTeam[scope.teamId] ?? 90);

  it('scrubs a launched plan past retention, keeps the row and its metadata, and reports it', async () => {
    const db = table([row('old'), row('young', { approvedAt: daysAgo(10) })]);
    const result = await expireRunPlans(db as never, NOW, { launchedRetentionDays: retention({}) });
    expect(result.scrubbed).toEqual([{ id: 'old', mode: 'delivering', teamId: 't1' }]);
    const old = db.rows[0] as Row;
    expect(old).toMatchObject({
      agentPins: { implementer: 3 },
      catalogHash: SCRUBBED_HASH,
      intent: '',
      routerCandidates: {},
      scrubbedAt: NOW,
      skeletonReport: {},
      spec: {},
      specHash: SCRUBBED_HASH,
      status: 'LAUNCHED',
      validationReport: {},
    });
    // The cost keeps its numbers and loses the node ids and the sentence that quoted one.
    expect(old.costEstimate).toEqual({
      exclusions: '',
      fanOutWidthAssumed: 3,
      perStep: [],
      totalUsd: 1.25,
      unpriced: [],
    });
    expect(JSON.stringify(old)).not.toContain('node-secret');
    expect(JSON.stringify(old)).not.toContain('payroll');
    // The young plan is untouched, and nothing is deleted.
    expect((db.rows[1] as Row).intent).toBe('rotate the payroll keys');
    expect((db.rows[1] as Row).scrubbedAt).toBeNull();
    // Only EXPIRED and REJECTED rows are ever deleted; a launched plan is scrubbed, not deleted.
    expect(JSON.stringify(db.runPlan.deleteMany.mock.calls)).not.toContain('LAUNCHED');
  });

  it('does not scrub at the boundary before the retention has fully passed', async () => {
    const db = table([row('p', { approvedAt: new Date(NOW.getTime() - 90 * DAY + 1000) })]);
    const result = await expireRunPlans(db as never, NOW, { launchedRetentionDays: retention({}) });
    expect(result.scrubbed).toEqual([]);
  });

  it('never scrubs a plan whose retention resolves to 0', async () => {
    const db = table([row('forever', { approvedAt: daysAgo(3000) })]);
    const resolve = retention({ t1: 0 });
    const result = await expireRunPlans(db as never, NOW, { launchedRetentionDays: resolve });
    expect(result.scrubbed).toEqual([]);
    expect((db.rows[0] as Row).intent).toBe('rotate the payroll keys');
    expect(db.runPlan.updateMany).not.toHaveBeenCalled();
  });

  it('resolves the retention per team and organization', async () => {
    const db = table([
      row('a', { approvedAt: daysAgo(40), orgId: 'o1', teamId: 't1' }),
      row('b', { approvedAt: daysAgo(40), orgId: 'o2', teamId: 't2' }),
      row('c', { approvedAt: daysAgo(40), orgId: 'o3', teamId: 't3' }),
    ]);
    const resolve = vi.fn(async (s: { teamId: string; orgId: string }) =>
      s.teamId === 't1' ? 30 : s.teamId === 't2' ? 60 : 0
    );
    const result = await expireRunPlans(db as never, NOW, { launchedRetentionDays: resolve });
    expect(result.scrubbed.map((p) => p.id)).toEqual(['a']);
    expect(resolve).toHaveBeenCalledWith({ orgId: 'o2', teamId: 't2' });
  });

  it('is idempotent: a second sweep scrubs nothing', async () => {
    const db = table([row('old')]);
    const opts = { launchedRetentionDays: retention({}) };
    expect((await expireRunPlans(db as never, NOW, opts)).scrubbed).toHaveLength(1);
    expect((await expireRunPlans(db as never, NOW, opts)).scrubbed).toEqual([]);
  });

  it('is race-safe: the write repeats the status and unscrubbed predicates, and a lost race reports nothing', async () => {
    const db = table([row('old')]);
    // Another sweeper scrubs the plan between this sweep's read and its write.
    db.runPlan.updateMany.mockImplementationOnce(async () => ({ count: 0 }));
    const result = await expireRunPlans(db as never, NOW, { launchedRetentionDays: retention({}) });
    expect(result.scrubbed).toEqual([]);
    expect(db.runPlan.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'old', scrubbedAt: null, status: 'LAUNCHED', teamId: 't1' },
    });
  });

  it('never scrubs a plan in another state', async () => {
    const db = table([row('r', { status: 'APPROVED' }), row('x', { status: 'REJECTED' })]);
    const result = await expireRunPlans(db as never, NOW, { launchedRetentionDays: retention({}) });
    expect(result.scrubbed).toEqual([]);
  });

  it('scrubs nothing for a team whose retention cannot be read', async () => {
    const db = table([row('old')]);
    const result = await expireRunPlans(db as never, NOW, {
      launchedRetentionDays: async () => {
        throw new Error('db');
      },
    });
    expect(result.scrubbed).toEqual([]);
  });

  it('bounds one sweep to SCRUB_BATCH plans', async () => {
    const db = table(Array.from({ length: SCRUB_BATCH + 5 }, (_, i) => row(`p${i}`)));
    const result = await expireRunPlans(db as never, NOW, { launchedRetentionDays: retention({}) });
    expect(result.scrubbed).toHaveLength(SCRUB_BATCH);
  });

  it('shares one batch fairly: a team with a backlog cannot starve the others', async () => {
    const rows = [
      ...Array.from({ length: 500 }, (_, i) => row(`a${i}`, { teamId: 'tA' })),
      ...['b0', 'b1', 'b2'].map((id) => row(id, { teamId: 'tB' })),
      ...['c0', 'c1', 'c2'].map((id) => row(id, { teamId: 'tC' })),
    ];
    const db = table(rows);
    const result = await expireRunPlans(db as never, NOW, { launchedRetentionDays: retention({}) });
    const byTeam = (t: string) => result.scrubbed.filter((p) => p.teamId === t).length;
    expect(byTeam('tB')).toBe(3);
    expect(byTeam('tC')).toBe(3);
    expect(byTeam('tA')).toBe(SCRUB_BATCH - 6);
    expect(result.scrubbed).toHaveLength(SCRUB_BATCH);
  });

  it('finds the teams with an aggregate, not by loading plan rows, and never reads a retention-0 team', async () => {
    const db = table([row('keep', { teamId: 'tZero' }), row('old', { teamId: 't1' })]);
    const result = await expireRunPlans(db as never, NOW, {
      launchedRetentionDays: retention({ tZero: 0 }),
    });
    expect(result.scrubbed.map((p) => p.id)).toEqual(['old']);
    expect(db.runPlan.groupBy).toHaveBeenCalledTimes(1);
    const planReads = db.runPlan.findMany.mock.calls
      .map((c) => (c[0] as Args).where)
      .filter((w) => w.status === 'LAUNCHED');
    expect(planReads.length).toBeGreaterThan(0);
    // Every plan read names one team, and never the retention-0 team.
    for (const where of planReads) {
      expect(where.teamId).toBeDefined();
      expect(where.teamId).not.toBe('tZero');
    }
  });
});
