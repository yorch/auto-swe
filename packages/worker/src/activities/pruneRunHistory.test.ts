import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Run {
  id: string;
  workflowId: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  transcriptLegalHold?: boolean;
  /** Latest step start and trace creation, for the recent-activity guard. */
  stepStartedAt?: Date;
  traceCreatedAt?: Date;
}

const db = vi.hoisted(() => ({
  /** Workflow ids whose ledger row is not terminal, or has an open pull request. */
  activeWorkflowIds: new Set<string>(),
  deletedArtifacts: [] as string[],
  failingArtifactIds: new Set<string>(),
  /** Run ids with a callback still pending. */
  pendingDeliveryRunIds: new Set<string>(),
  /** Run ids with a rollup row, and with an LLM trace. */
  rolledRunIds: new Set<string>(),
  runs: [] as Run[],
  s3Artifacts: [] as Array<{ id: string; runId: string }>,
  tracedRunIds: new Set<string>(),
}));

const TERMINAL = ['SUCCESS', 'FAILED', 'TIMED_OUT', 'SKIPPED', 'CANCELLED'];

interface RunWhere {
  status: { in: string[] };
  endedAt: { lt: Date };
  startedAt: { lt: Date };
  transcriptLegalHold: boolean;
  steps: { none: { startedAt: { gte: Date } } };
  traces: { none: { createdAt: { gte: Date } } };
  artifacts?: { none: { backend: string } };
  id?: { in: string[] };
  OR?: Array<{ startedAt: { gt: Date } | Date; id?: { gt: string } }>;
}

/** The subset of Prisma's `where` the sweep writes, evaluated with real semantics. */
function matches(r: Run, where: RunWhere): boolean {
  const keyset =
    !where.OR ||
    where.OR.some((c) =>
      c.startedAt instanceof Date
        ? r.startedAt.getTime() === c.startedAt.getTime() && r.id > (c.id?.gt ?? '')
        : r.startedAt > c.startedAt.gt
    );
  return (
    where.status.in.includes(r.status) &&
    r.endedAt !== null &&
    r.endedAt < where.endedAt.lt &&
    r.startedAt < where.startedAt.lt &&
    (r.transcriptLegalHold ?? false) === where.transcriptLegalHold &&
    !(r.stepStartedAt && r.stepStartedAt >= where.steps.none.startedAt.gte) &&
    !(r.traceCreatedAt && r.traceCreatedAt >= where.traces.none.createdAt.gte) &&
    keyset &&
    (!where.artifacts || !db.s3Artifacts.some((a) => a.runId === r.id)) &&
    (!where.id || where.id.in.includes(r.id))
  );
}

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    activeWorkflow: {
      findMany: vi.fn(async ({ where }: { where: { temporalWorkflowId: { in: string[] } } }) =>
        where.temporalWorkflowId.in
          .filter((w) => db.activeWorkflowIds.has(w))
          .map((w) => ({ temporalWorkflowId: w }))
      ),
    },
    agentTrace: {
      groupBy: vi.fn(async ({ where }: { where: { runId: { in: string[] } } }) =>
        where.runId.in.filter((id) => db.tracedRunIds.has(id)).map((runId) => ({ runId }))
      ),
    },
    agentTraceDailyUsage: {
      groupBy: vi.fn(async ({ where }: { where: { runId: { in: string[] } } }) =>
        where.runId.in.filter((id) => db.rolledRunIds.has(id)).map((runId) => ({ runId }))
      ),
    },
    outboundDelivery: {
      findMany: vi.fn(async ({ where }: { where: { workflowRunId: { in: string[] } } }) =>
        where.workflowRunId.in
          .filter((id) => db.pendingDeliveryRunIds.has(id))
          .map((workflowRunId) => ({ workflowRunId }))
      ),
    },
    workflowArtifact: {
      findMany: vi.fn(async ({ where }: { where: { runId: { in: string[] } } }) =>
        db.s3Artifacts.filter((a) => where.runId.in.includes(a.runId))
      ),
    },
    workflowRun: {
      deleteMany: vi.fn(async ({ where }: { where: RunWhere }) => {
        const before = db.runs.length;
        db.runs = db.runs.filter((r) => !matches(r, where));
        return { count: before - db.runs.length };
      }),
      findMany: vi.fn(
        async ({
          orderBy,
          take,
          where,
        }: {
          orderBy: Array<Record<string, 'asc'>>;
          take: number;
          where: RunWhere;
        }) => {
          // The keyset only works against this exact ordering.
          expect(orderBy).toEqual([{ startedAt: 'asc' }, { id: 'asc' }]);
          return db.runs
            .filter((r) => matches(r, where))
            .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || (a.id < b.id ? -1 : 1))
            .slice(0, take)
            .map((r) => ({ id: r.id, startedAt: r.startedAt, workflowId: r.workflowId }));
        }
      ),
    },
  },
}));
const storage = vi.hoisted(() => ({ backend: 's3' as 's3' | 'inline' }));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveStorageConfig: () => ({ backend: storage.backend }),
}));
vi.mock('@auto-swe/shared/lib/artifactStore', () => ({
  deleteArtifact: vi.fn(async (id: string) => {
    if (db.failingArtifactIds.has(id)) {
      throw new Error('object store unavailable');
    }
    db.deletedArtifacts.push(id);
  }),
}));
const setting = vi.hoisted(() => ({ days: 90, fail: false }));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async () => {
    if (setting.fail) {
      throw new Error('settings database down');
    }
    return setting.days;
  }),
}));
const heartbeat = vi.hoisted(() => vi.fn());
vi.mock('@temporalio/activity', () => ({ heartbeat: (...a: unknown[]) => heartbeat(...a) }));
const logWarn = vi.fn();
const auditLog = vi.fn();
vi.mock('../lib/activityLog.js', () => ({
  auditLog: (...a: unknown[]) => auditLog(...a),
  logWarn: (...a: unknown[]) => logWarn(...a),
}));

import {
  pruneRunHistory,
  RUN_PRUNE_BATCH,
  RUN_PRUNE_BATCH_BUDGET_MS,
  RUN_PRUNE_MAX_DELETED,
  RUN_TERMINAL_STATUSES,
} from './pruneRunHistory.js';

const NOW = new Date('2026-10-01T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

function run(id: string, endedDaysAgo: number | null, extra: Partial<Run> = {}): Run {
  return {
    endedAt: endedDaysAgo === null ? null : daysAgo(endedDaysAgo),
    id,
    startedAt: daysAgo((endedDaysAgo ?? 0) + 1),
    status: 'SUCCESS',
    workflowId: `wf-${id}`,
    ...extra,
  };
}
const ids = () => db.runs.map((r) => r.id);

beforeEach(async () => {
  vi.clearAllMocks();
  db.runs = [];
  db.activeWorkflowIds = new Set();
  db.pendingDeliveryRunIds = new Set();
  db.tracedRunIds = new Set();
  db.rolledRunIds = new Set();
  db.s3Artifacts = [];
  db.failingArtifactIds = new Set();
  db.deletedArtifacts = [];
  setting.days = 90;
  setting.fail = false;
  storage.backend = 's3';
});

describe('pruneRunHistory', () => {
  it('names exactly the finished statuses', () => {
    expect([...RUN_TERMINAL_STATUSES].sort()).toEqual([...TERMINAL].sort());
  });

  it('deletes nothing and reads nothing when retention is 0 (keep forever)', async () => {
    setting.days = 0;
    db.runs = [run('ancient', 4000)];
    const { prisma } = await import('@auto-swe/shared/db');
    await expect(pruneRunHistory(NOW)).resolves.toEqual({
      deleted: 0,
      kept: { held: 0, pendingCallback: 0, storageFailed: 0, unrolledSpend: 0 },
      more: false,
      retentionDays: 0,
    });
    expect(ids()).toEqual(['ancient']);
    expect(prisma.workflowRun.findMany).not.toHaveBeenCalled();
    expect(prisma.workflowRun.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes only finished runs that ended before the cutoff', async () => {
    db.runs = [
      run('old-ok', 100),
      run('old-failed', 91, { status: 'FAILED' }),
      run('old-cancelled', 120, { status: 'CANCELLED' }),
      run('old-timed-out', 120, { status: 'TIMED_OUT' }),
      run('old-skipped', 120, { status: 'SKIPPED' }),
      run('recent', 30),
      run('old-running', 400, { endedAt: null, status: 'RUNNING' }),
      run('old-running-with-end', 400, { status: 'RUNNING' }),
    ];
    const result = await pruneRunHistory(NOW);
    expect(result).toMatchObject({ deleted: 5, more: false, retentionDays: 90 });
    expect(ids().sort()).toEqual(['old-running', 'old-running-with-end', 'recent']);
    expect(auditLog).toHaveBeenCalledWith(expect.stringContaining('deleted 5'));
  });

  it('keeps a run under a transcript legal hold', async () => {
    db.runs = [run('held', 200, { transcriptLegalHold: true }), run('free', 200)];
    await pruneRunHistory(NOW);
    expect(ids()).toEqual(['held']);
  });

  it('keeps a run whose workflow is still live or has an open pull request', async () => {
    db.runs = [run('live', 200), run('open-pr', 200), run('done', 200)];
    db.activeWorkflowIds = new Set(['wf-live', 'wf-open-pr']);
    const result = await pruneRunHistory(NOW);
    expect(ids().sort()).toEqual(['live', 'open-pr']);
    expect(result.kept.held).toBe(2);
  });

  it('keeps a run with a callback still pending', async () => {
    db.runs = [run('pending-cb', 200), run('delivered', 200)];
    db.pendingDeliveryRunIds = new Set(['pending-cb']);
    const result = await pruneRunHistory(NOW);
    expect(ids()).toEqual(['pending-cb']);
    expect(result.kept.pendingCallback).toBe(1);
  });

  it('keeps a run whose LLM spend is not in the usage rollup yet', async () => {
    db.runs = [run('unrolled', 200), run('rolled', 200), run('no-llm', 200)];
    db.tracedRunIds = new Set(['unrolled', 'rolled']);
    db.rolledRunIds = new Set(['rolled']);
    const result = await pruneRunHistory(NOW);
    expect(ids()).toEqual(['unrolled']);
    expect(result.kept.unrolledSpend).toBe(1);
  });

  it('removes object-store artifacts first, and keeps a run whose artifact could not go', async () => {
    db.runs = [run('a', 200), run('b', 200)];
    db.s3Artifacts = [
      { id: 'art-a', runId: 'a' },
      { id: 'art-b', runId: 'b' },
    ];
    db.failingArtifactIds = new Set(['art-b']);
    const result = await pruneRunHistory(NOW);
    expect(db.deletedArtifacts).toEqual(['art-a']);
    expect(ids()).toEqual(['b']);
    expect(result.kept.storageFailed).toBe(1);
    expect(logWarn).toHaveBeenCalled();
  });

  it('does not stall on kept runs at the front of the queue', async () => {
    // More kept runs than one batch, older than the deletable ones behind them.
    const kept = RUN_PRUNE_BATCH * 2 + 5;
    db.runs = [
      ...Array.from({ length: kept }, (_, i) =>
        run(`kept-${i}`, 500, { transcriptLegalHold: false })
      ),
      run('deletable', 100),
    ];
    db.pendingDeliveryRunIds = new Set(db.runs.slice(0, kept).map((r) => r.id));
    const result = await pruneRunHistory(NOW);
    expect(ids()).not.toContain('deletable');
    expect(ids()).toHaveLength(kept);
    expect(result.deleted).toBe(1);
  });

  it('keeps reading after a batch whose every run was deleted', async () => {
    // The last run of batch 1 is gone by the time batch 2 is read, so the read cannot depend on it.
    const total = RUN_PRUNE_BATCH * 2 + 30;
    db.runs = Array.from({ length: total }, (_, i) => run(`r${String(i).padStart(4, '0')}`, 200));
    const result = await pruneRunHistory(NOW);
    expect(result).toMatchObject({ deleted: total, more: false });
    expect(ids()).toEqual([]);
  });

  it('walks kept and deleted runs across batch boundaries', async () => {
    const total = RUN_PRUNE_BATCH * 3 + 17;
    db.runs = Array.from({ length: total }, (_, i) =>
      run(`r${String(i).padStart(4, '0')}`, 200 - Math.floor(i / 7))
    );
    // Every third run is kept (a pending callback); the rest are deletable.
    const keptIds = db.runs.filter((_, i) => i % 3 === 0).map((r) => r.id);
    db.pendingDeliveryRunIds = new Set(keptIds);
    const result = await pruneRunHistory(NOW);
    expect(ids().sort()).toEqual([...keptIds].sort());
    expect(result).toMatchObject({ deleted: total - keptIds.length, more: false });
    expect(result.kept.pendingCallback).toBe(keptIds.length);
  });

  it('keeps a run with a step started or a trace written since the cutoff', async () => {
    // A reused workflow id keeps its first execution's end state while a newer one is live.
    db.runs = [
      run('live-step', 200, { stepStartedAt: daysAgo(1) }),
      run('live-trace', 200, { traceCreatedAt: daysAgo(2) }),
      run('quiet', 200, { stepStartedAt: daysAgo(199), traceCreatedAt: daysAgo(199) }),
    ];
    await pruneRunHistory(NOW);
    expect(ids().sort()).toEqual(['live-step', 'live-trace']);
  });

  it('walks past a kept prefix far larger than a sweep deletes, in one sweep', async () => {
    // Permanently kept runs (here: a callback that never completes) ahead of the deletable ones.
    const prefix = RUN_PRUNE_MAX_DELETED + 500;
    db.runs = [
      ...Array.from({ length: prefix }, (_, i) => run(`kept-${String(i).padStart(6, '0')}`, 500)),
      ...Array.from({ length: 5 }, (_, i) => run(`deletable-${i}`, 100)),
    ];
    db.pendingDeliveryRunIds = new Set(db.runs.slice(0, prefix).map((r) => r.id));
    const result = await pruneRunHistory(NOW);
    expect(result).toMatchObject({ deleted: 5, more: false });
    expect(result.kept.pendingCallback).toBe(prefix);
    expect(ids()).toHaveLength(prefix);
  });

  it('counts a run once when the read returns it again at a batch boundary', async () => {
    const { prisma } = await import('@auto-swe/shared/db');
    const rows = Array.from({ length: RUN_PRUNE_BATCH + 5 }, (_, i) => ({
      id: `r${i}`,
      startedAt: daysAgo(200),
      workflowId: `wf-r${i}`,
    }));
    db.pendingDeliveryRunIds = new Set(rows.map((r) => r.id));
    vi.mocked(prisma.workflowRun.findMany)
      .mockResolvedValueOnce(rows.slice(0, RUN_PRUNE_BATCH) as never)
      // The boundary row again (microseconds lost to milliseconds), then the rest.
      .mockResolvedValueOnce(rows.slice(RUN_PRUNE_BATCH - 1) as never);
    const result = await pruneRunHistory(NOW);
    expect(result.kept.pendingCallback).toBe(RUN_PRUNE_BATCH + 5);
  });

  it('does not delete a run the read returned if a legal hold landed since', async () => {
    db.runs = [run('held-late', 200), run('plain', 200)];
    const { prisma } = await import('@auto-swe/shared/db');
    vi.mocked(prisma.activeWorkflow.findMany).mockImplementationOnce((async () => {
      const r = db.runs.find((x) => x.id === 'held-late');
      if (r) {
        r.transcriptLegalHold = true;
      }
      return [];
    }) as never);
    const result = await pruneRunHistory(NOW);
    expect(ids()).toEqual(['held-late']);
    expect(result.deleted).toBe(1);
  });

  it('never reads runs with object-store artifacts when no object store is configured', async () => {
    storage.backend = 'inline';
    db.runs = [run('s3-run', 200), run('plain', 200)];
    db.s3Artifacts = [{ id: 'art', runId: 's3-run' }];
    const result = await pruneRunHistory(NOW);
    expect(ids()).toEqual(['s3-run']);
    expect(result.deleted).toBe(1);
    expect(db.deletedArtifacts).toEqual([]);
  });

  it('stops at its wall-clock budget between batches and says more is left', async () => {
    db.runs = Array.from({ length: RUN_PRUNE_BATCH * 3 }, (_, i) =>
      run(`r${String(i).padStart(4, '0')}`, 200)
    );
    const t = 0;
    let checks = 0;
    // The budget lapses after the first batch has been started.
    const clock = () => (++checks > 2 ? t + RUN_PRUNE_BATCH_BUDGET_MS + 1 : t);
    const result = await pruneRunHistory(NOW, clock);
    expect(result).toMatchObject({ deleted: RUN_PRUNE_BATCH, more: true });
    expect(ids()).toHaveLength(RUN_PRUNE_BATCH * 2);
  });

  it('stops deleting object-store artifacts at its budget and keeps the runs it did not reach', async () => {
    db.runs = [run('a', 200), run('b', 200), run('c', 200)];
    db.s3Artifacts = [
      { id: 'art-a', runId: 'a' },
      { id: 'art-b', runId: 'b' },
      { id: 'art-c', runId: 'c' },
    ];
    let t = 0;
    const { deleteArtifact } = await import('@auto-swe/shared/lib/artifactStore');
    vi.mocked(deleteArtifact).mockImplementationOnce(async (id: string) => {
      db.deletedArtifacts.push(id);
      t = RUN_PRUNE_BATCH_BUDGET_MS + 1;
    });
    const result = await pruneRunHistory(NOW, () => t);
    expect(db.deletedArtifacts).toEqual(['art-a']);
    expect(ids().sort()).toEqual(['b', 'c']);
    expect(result).toMatchObject({ deleted: 1, more: true });
  });

  it('heartbeats before every batch and every object-store deletion', async () => {
    db.runs = Array.from({ length: RUN_PRUNE_BATCH * 2 + 3 }, (_, i) =>
      run(`r${String(i).padStart(4, '0')}`, 200)
    );
    db.s3Artifacts = [
      { id: 'a1', runId: 'r0000' },
      { id: 'a2', runId: 'r0001' },
    ];
    await pruneRunHistory(NOW);
    // Three batches, two artifacts.
    expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('never deletes more than its cap, even when batches do not divide it', async () => {
    const { prisma } = await import('@auto-swe/shared/db');
    const takes: number[] = [];
    let n = 0;
    const origFind = vi.mocked(prisma.workflowRun.findMany).getMockImplementation();
    const origDelete = vi.mocked(prisma.workflowRun.deleteMany).getMockImplementation();
    vi.mocked(prisma.workflowRun.findMany).mockImplementation((async ({
      take,
    }: {
      take: number;
    }) => {
      takes.push(take);
      return Array.from({ length: take }, () => {
        n += 1;
        return { id: `x${n}`, startedAt: new Date(n), workflowId: `wf-${n}` };
      });
    }) as never);
    // Each statement deletes 70 of its 100 (30 were taken by a legal hold meanwhile).
    vi.mocked(prisma.workflowRun.deleteMany).mockImplementation((async ({
      where,
    }: {
      where: { id: { in: string[] } };
    }) => ({ count: Math.min(70, where.id.in.length) })) as never);
    const result = await pruneRunHistory(NOW);
    vi.mocked(prisma.workflowRun.findMany).mockImplementation(origFind as never);
    vi.mocked(prisma.workflowRun.deleteMany).mockImplementation(origDelete as never);
    expect(result.deleted).toBeLessThanOrEqual(RUN_PRUNE_MAX_DELETED);
    expect(result).toMatchObject({ more: true });
    expect(Math.max(...takes)).toBeLessThanOrEqual(RUN_PRUNE_BATCH);
    expect(takes[takes.length - 1]).toBeLessThan(RUN_PRUNE_BATCH);
  });

  it('stops instead of spinning when a batch ends where the previous one did', async () => {
    const { prisma } = await import('@auto-swe/shared/db');
    const rows = Array.from({ length: RUN_PRUNE_BATCH }, (_, i) => ({
      id: `r${i}`,
      startedAt: daysAgo(200),
      workflowId: `wf-r${i}`,
    }));
    db.pendingDeliveryRunIds = new Set(rows.map((r) => r.id));
    const read = vi.mocked(prisma.workflowRun.findMany);
    const origFind = read.getMockImplementation();
    read.mockImplementation((async () => rows) as never);
    const result = await pruneRunHistory(NOW);
    read.mockImplementation(origFind as never);
    expect(result.more).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.kept.pendingCallback).toBe(RUN_PRUNE_BATCH);
  });

  it('warns once per sweep that runs with object-store artifacts are not considered', async () => {
    storage.backend = 'inline';
    db.runs = [run('plain', 200)];
    await pruneRunHistory(NOW);
    const warnings = logWarn.mock.calls.filter(([m]) => String(m).includes('object store'));
    expect(warnings).toHaveLength(1);
  });

  it('does not warn about the object store when retention is off', async () => {
    storage.backend = 'inline';
    setting.days = 0;
    await pruneRunHistory(NOW);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('logs and returns when the setting cannot be read, instead of throwing', async () => {
    setting.fail = true;
    const result = await pruneRunHistory(NOW);
    expect(result).toMatchObject({ deleted: 0, more: true });
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining('run history sweep'),
      expect.objectContaining({ error: 'settings database down' })
    );
  });

  it('deletes in bounded batches and says more is left at its batch limit', async () => {
    const { prisma } = await import('@auto-swe/shared/db');
    let n = 0;
    // An endless backlog: every read finds a full batch of new deletable runs.
    vi.mocked(prisma.workflowRun.findMany).mockImplementation((async () =>
      Array.from({ length: RUN_PRUNE_BATCH }, () => {
        n += 1;
        return { id: `r${n}`, workflowId: `wf-${n}` };
      })) as never);
    vi.mocked(prisma.workflowRun.deleteMany).mockImplementation((async ({
      where,
    }: {
      where: { id: { in: string[] } };
    }) => ({ count: where.id.in.length })) as never);
    const result = await pruneRunHistory(NOW);
    expect(result).toMatchObject({ deleted: RUN_PRUNE_MAX_DELETED, more: true });
    expect(prisma.workflowRun.deleteMany).toHaveBeenCalledTimes(
      RUN_PRUNE_MAX_DELETED / RUN_PRUNE_BATCH
    );
    const sizes = vi
      .mocked(prisma.workflowRun.deleteMany)
      .mock.calls.map(
        ([args]) => (args as unknown as { where: { id: { in: string[] } } }).where.id.in.length
      );
    expect(Math.max(...sizes)).toBeLessThanOrEqual(RUN_PRUNE_BATCH);
    expect(logWarn).toHaveBeenCalled();
  });

  it('never throws: a failing batch is logged and the sweep reports what it deleted', async () => {
    db.runs = [run('x', 200)];
    const { prisma } = await import('@auto-swe/shared/db');
    vi.mocked(prisma.workflowRun.deleteMany).mockRejectedValueOnce(new Error('db down'));
    const result = await pruneRunHistory(NOW);
    expect(result).toMatchObject({ deleted: 0, more: true });
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining('run history sweep'),
      expect.objectContaining({ error: 'db down' })
    );
  });
});
