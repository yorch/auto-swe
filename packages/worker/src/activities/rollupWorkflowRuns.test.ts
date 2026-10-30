import { TX_TIMEOUT_MS } from '@auto-swe/shared/lib/agentTraceRollup';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-20T12:00:00.000Z');
const TODAY = Date.parse('2026-10-20T00:00:00.000Z');

const mocks = vi.hoisted(() => ({
  backfillDays: 0,
  built: [] as Array<{ builtAt: Date | null; day: Date }>,
  createManySizes: [] as number[],
  detectionPageSizes: [] as number[],
  dirtyEndedRuns: [] as Array<{
    endedAt: Date;
    id?: string;
    startedAt: Date;
    updatedAt?: Date;
  }>,
  dirtyFixSteps: [] as Array<{ run: { startedAt: Date } }>,
  dirtyHumanSteps: [] as Array<{ requestedAt: Date }>,
  dirtyPullRequests: [] as Array<{
    closedAt: Date | null;
    mergedAt: Date | null;
    run: { startedAt: Date };
  }>,
  dirtyReviewerTraces: [] as Array<{ run: { startedAt: Date } }>,
  events: [] as string[],
  failCreateMany: false,
  lastSuccessfulStartAt: null as Date | null,
  oldest: null as Date | null,
  pendingDirtyDays: [] as Date[],
  present: [] as Date[],
  recomputeDays: 2,
  runsPerDay: 0,
  stateUpdates: [] as Date[],
  transactionDays: [] as Date[],
  transactionOptions: [] as Array<{ maxWait?: number; timeout?: number }>,
}));

vi.mock('@temporalio/activity', () => ({
  heartbeat: (message: string) => mocks.events.push(`heartbeat:${message}`),
}));

vi.mock('@auto-swe/shared/db', () => {
  const txClient = {
    humanStepDailyRollup: {
      createMany: async ({ data }: { data: unknown[] }) => {
        mocks.createManySizes.push(data.length);
      },
      deleteMany: async ({ where }: { where: { day: Date } }) => {
        mocks.transactionDays.push(where.day);
      },
    },
    reviewVerdictDailyRollup: {
      createMany: async ({ data }: { data: unknown[] }) => {
        mocks.createManySizes.push(data.length);
      },
      deleteMany: async ({ where }: { where: { day: Date } }) => {
        mocks.transactionDays.push(where.day);
      },
    },
    workflowRunDailyRollup: {
      createMany: async ({ data }: { data: unknown[] }) => {
        mocks.createManySizes.push(data.length);
        if (mocks.failCreateMany) {
          throw new Error('createMany failed');
        }
      },
      deleteMany: async ({ where }: { where: { day: Date } }) => {
        mocks.transactionDays.push(where.day);
      },
    },
  };
  return {
    prisma: {
      $transaction: async (
        callback: (tx: typeof txClient) => Promise<void>,
        options: { maxWait?: number; timeout?: number }
      ) => {
        mocks.transactionOptions.push(options);
        return callback(txClient);
      },
      agentTrace: { findMany: async () => mocks.dirtyReviewerTraces },
      pullRequest: { findMany: async () => mocks.dirtyPullRequests },
      rollupSweepState: {
        findUnique: async () =>
          mocks.lastSuccessfulStartAt
            ? {
                lastSuccessfulStartAt: mocks.lastSuccessfulStartAt,
                pendingDirtyDays: mocks.pendingDirtyDays,
              }
            : null,
        updateMany: async ({
          data,
        }: {
          data: { lastSuccessfulStartAt: Date; pendingDirtyDays: Date[] };
        }) => {
          if (data.lastSuccessfulStartAt) {
            mocks.lastSuccessfulStartAt = data.lastSuccessfulStartAt;
            mocks.stateUpdates.push(data.lastSuccessfulStartAt);
          }
          mocks.pendingDirtyDays = data.pendingDirtyDays;
          return { count: 1 };
        },
        upsert: async ({
          create,
        }: {
          create: { lastSuccessfulStartAt: Date; name: string; pendingDirtyDays: Date[] };
        }) => {
          mocks.lastSuccessfulStartAt ??= create.lastSuccessfulStartAt;
          mocks.pendingDirtyDays = create.pendingDirtyDays;
          return { name: create.name };
        },
      },
      workflowHumanStep: {
        findMany: async ({ where }: { where: { resolvedAt?: unknown } }) =>
          where.resolvedAt ? mocks.dirtyHumanSteps : [],
      },
      workflowRun: {
        aggregate: async () => ({ _min: { startedAt: mocks.oldest } }),
        findMany: async ({
          cursor,
          skip,
          take,
          where,
        }: {
          cursor?: { id: string };
          skip?: number;
          take?: number;
          where: {
            endedAt?: unknown;
            updatedAt?: unknown;
            startedAt?: { gte?: Date; lt?: Date };
          };
        }) => {
          if (where.endedAt) {
            return mocks.dirtyEndedRuns;
          }
          if (where.updatedAt) {
            const pageSize = take ?? mocks.dirtyEndedRuns.length;
            mocks.detectionPageSizes.push(pageSize);
            const cursorIndex = cursor
              ? mocks.dirtyEndedRuns.findIndex(
                  (run, index) => (run.id ?? `run-${index}`) === cursor.id
                ) + (skip ?? 0)
              : 0;
            return mocks.dirtyEndedRuns
              .slice(cursorIndex, cursorIndex + pageSize)
              .map((run, index) => ({
                id: run.id ?? `run-${cursorIndex + index}`,
                startedAt: run.startedAt,
              }));
          }
          const day = where.startedAt?.gte;
          if (!day) {
            return [];
          }
          mocks.events.push(`read:${day.toISOString().slice(0, 10)}`);
          return Array.from({ length: mocks.runsPerDay }, (_, index) => ({
            attributedOrgId: 'org',
            attributedRepoId: `repo-${index}`,
            attributedTeamId: 'team',
            costUsdAccrued: 0,
            endedAt: null,
            estimatedHumanTimeSaved: null,
            hadHumanStep: false,
            id: `${day.toISOString()}-${index}`,
            outcomeDomain: null,
            outcomeType: null,
            startedAt: day,
            status: 'SUCCESS',
            templateId: 'template',
            templateVersion: 1,
            wasAutonomous: true,
            workflowId: `workflow-${index}`,
            workRequest: { activeWorkflows: [] },
          }));
        },
      },
      workflowRunDailyRollup: {
        groupBy: async ({ where }: { where: { day?: { in?: Date[] } } }) =>
          where.day?.in
            ? mocks.built.filter((row) => where.day?.in?.includes(row.day))
            : mocks.present.map((day) => ({ day })),
      },
      workflowStep: {
        findMany: async ({ where }: { where: { endedAt?: unknown } }) =>
          where.endedAt ? mocks.dirtyFixSteps : [],
      },
    },
  };
});

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveScheduledSweeps: () => ({
    workflowRunRollup: {
      backfillDays: mocks.backfillDays,
      recomputeDays: mocks.recomputeDays,
    },
  }),
  validateScheduledSweepsEnv: () => [],
}));
vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: (_reason: string, _tables: string[], callback: () => unknown) => callback(),
}));
vi.mock('../lib/activityLog.js', () => ({ logWarn: vi.fn() }));

import {
  MAX_BACKFILL_DAYS_PER_SWEEP,
  MAX_DIRTY_DAYS_PER_SWEEP,
  rollupWorkflowRuns,
} from './rollupWorkflowRuns.js';

beforeEach(() => {
  mocks.backfillDays = 0;
  mocks.built = [];
  mocks.events = [];
  mocks.dirtyEndedRuns = [];
  mocks.dirtyFixSteps = [];
  mocks.dirtyHumanSteps = [];
  mocks.dirtyPullRequests = [];
  mocks.dirtyReviewerTraces = [];
  mocks.failCreateMany = false;
  mocks.lastSuccessfulStartAt = null;
  mocks.oldest = null;
  mocks.pendingDirtyDays = [];
  mocks.present = [];
  mocks.recomputeDays = 2;
  mocks.runsPerDay = 0;
  mocks.stateUpdates = [];
  mocks.detectionPageSizes = [];
  mocks.transactionDays = [];
  mocks.transactionOptions = [];
  mocks.createManySizes = [];
});

describe('rollupWorkflowRuns', () => {
  it('rejects a non-canonical timestamp input', async () => {
    await expect(rollupWorkflowRuns('2026-10-20T12:00:00Z')).rejects.toThrow(
      'now must be a canonical UTC timestamp'
    );
  });

  it('reads only the selected completed days', async () => {
    const result = await rollupWorkflowRuns(NOW.toISOString());
    expect(result.days).toBe(2);
    expect(mocks.events.filter((event) => event.startsWith('read:'))).toEqual([
      `read:${new Date(TODAY - 2 * DAY_MS).toISOString().slice(0, 10)}`,
      `read:${new Date(TODAY - DAY_MS).toISOString().slice(0, 10)}`,
    ]);
  });

  it('caps historical backfill work per sweep', async () => {
    mocks.backfillDays = 365;
    mocks.oldest = new Date(TODAY - 500 * DAY_MS);
    const result = await rollupWorkflowRuns(NOW.toISOString());
    expect(result.days).toBe(2 + MAX_BACKFILL_DAYS_PER_SWEEP);
  });

  it('replaces each day in a bounded transaction and chunks large inserts', async () => {
    mocks.recomputeDays = 1;
    mocks.runsPerDay = 501;
    const result = await rollupWorkflowRuns(NOW.toISOString());
    expect(result.rows).toBe(501);
    expect(mocks.createManySizes).toEqual([500, 1]);
    expect(mocks.transactionDays).toEqual([
      new Date(TODAY - DAY_MS),
      new Date(TODAY - DAY_MS),
      new Date(TODAY - DAY_MS),
    ]);
    expect(mocks.transactionOptions).toEqual([{ maxWait: 30_000, timeout: TX_TIMEOUT_MS }]);
  });

  it('heartbeats before and after every selected day', async () => {
    await rollupWorkflowRuns(NOW.toISOString());
    expect(mocks.events.filter((event) => event.startsWith('heartbeat:'))).toEqual([
      'heartbeat:checking workflow rollup dirty days',
      'heartbeat:finished checking workflow rollup dirty days',
      `heartbeat:rolling up workflow runs for ${new Date(TODAY - 2 * DAY_MS).toISOString().slice(0, 10)}`,
      `heartbeat:finished workflow run rollup for ${new Date(TODAY - 2 * DAY_MS).toISOString().slice(0, 10)}`,
      `heartbeat:rolling up workflow runs for ${new Date(TODAY - DAY_MS).toISOString().slice(0, 10)}`,
      `heartbeat:finished workflow run rollup for ${new Date(TODAY - DAY_MS).toISOString().slice(0, 10)}`,
    ]);
  });

  it('rebuilds a frozen day when its run is finalized after the previous sweep', async () => {
    mocks.lastSuccessfulStartAt = new Date('2026-10-19T00:00:00.000Z');
    mocks.dirtyEndedRuns = [
      {
        endedAt: new Date('2026-10-20T10:00:00.000Z'),
        startedAt: new Date(TODAY - 45 * DAY_MS),
      },
    ];
    mocks.runsPerDay = 1;
    const result = await rollupWorkflowRuns(NOW.toISOString());
    expect(result.days).toBe(3);
    expect(mocks.events).toContain(
      `read:${new Date(TODAY - 45 * DAY_MS).toISOString().slice(0, 10)}`
    );
    expect(mocks.transactionDays.map((day) => day.getTime())).toContain(TODAY - 45 * DAY_MS);
    expect(mocks.stateUpdates).toEqual([NOW]);
  });

  it('rebuilds the old run day when its pull request merges after the previous sweep', async () => {
    mocks.lastSuccessfulStartAt = new Date('2026-10-19T00:00:00.000Z');
    mocks.dirtyPullRequests = [
      {
        closedAt: null,
        mergedAt: new Date('2026-10-20T10:00:00.000Z'),
        run: { startedAt: new Date(TODAY - 45 * DAY_MS) },
      },
    ];
    mocks.runsPerDay = 1;
    const result = await rollupWorkflowRuns(NOW.toISOString());
    expect(result.days).toBe(3);
    expect(mocks.transactionDays.map((day) => day.getTime())).toContain(TODAY - 45 * DAY_MS);
    expect(mocks.stateUpdates).toEqual([NOW]);
  });

  it('rebuilds days changed by PR updates, fix steps, reviewer traces, and human resolution', async () => {
    mocks.recomputeDays = 1;
    mocks.lastSuccessfulStartAt = new Date('2026-10-19T00:00:00.000Z');
    mocks.dirtyPullRequests = [
      {
        closedAt: null,
        mergedAt: null,
        run: { startedAt: new Date(TODAY - 40 * DAY_MS) },
      },
    ];
    mocks.dirtyFixSteps = [{ run: { startedAt: new Date(TODAY - 41 * DAY_MS) } }];
    mocks.dirtyReviewerTraces = [{ run: { startedAt: new Date(TODAY - 42 * DAY_MS) } }];
    mocks.dirtyHumanSteps = [{ requestedAt: new Date(TODAY - 43 * DAY_MS) }];

    const result = await rollupWorkflowRuns(NOW.toISOString());

    expect(result.days).toBe(5);
    expect(new Set(mocks.transactionDays.map((day) => day.getTime()))).toEqual(
      new Set([
        TODAY - DAY_MS,
        TODAY - 40 * DAY_MS,
        TODAY - 41 * DAY_MS,
        TODAY - 42 * DAY_MS,
        TODAY - 43 * DAY_MS,
      ])
    );
  });

  it('caps dirty-day work at sixty and advances the watermark with a durable backlog', async () => {
    mocks.lastSuccessfulStartAt = new Date('2026-10-19T00:00:00.000Z');
    mocks.dirtyEndedRuns = Array.from({ length: 61 }, (_, index) => ({
      endedAt: new Date('2026-10-20T10:00:00.000Z'),
      startedAt: new Date(TODAY - (index + 40) * DAY_MS),
    }));
    const result = await rollupWorkflowRuns(NOW.toISOString());
    expect(result.days).toBe(2 + MAX_DIRTY_DAYS_PER_SWEEP);
    expect(mocks.stateUpdates).toEqual([NOW]);
    expect(mocks.lastSuccessfulStartAt).toEqual(NOW);
    expect(mocks.pendingDirtyDays).toEqual([new Date(TODAY - 40 * DAY_MS)]);
  });

  it('moves through a dirty-day backlog on the next successful sweep', async () => {
    mocks.lastSuccessfulStartAt = new Date('2026-10-19T00:00:00.000Z');
    mocks.dirtyEndedRuns = Array.from({ length: 61 }, (_, index) => ({
      endedAt: new Date('2026-10-20T10:00:00.000Z'),
      id: `run-${index}`,
      startedAt: new Date(TODAY - (index + 40) * DAY_MS),
    }));
    await rollupWorkflowRuns(NOW.toISOString());
    expect(mocks.pendingDirtyDays).toHaveLength(1);
    const latestDay = mocks.pendingDirtyDays[0];
    mocks.dirtyEndedRuns = [];
    mocks.transactionDays = [];

    const nextSweep = new Date(NOW.getTime() + DAY_MS);
    await rollupWorkflowRuns(nextSweep.toISOString());

    expect(mocks.transactionDays.map((day) => day.getTime())).toContain(latestDay?.getTime());
    expect(mocks.pendingDirtyDays).toEqual([]);
    expect(mocks.lastSuccessfulStartAt).toEqual(nextSweep);
  });

  it('paginates dirty-source detection with bounded result batches', async () => {
    mocks.lastSuccessfulStartAt = new Date('2026-10-19T00:00:00.000Z');
    mocks.dirtyEndedRuns = Array.from({ length: 1_001 }, (_, index) => ({
      endedAt: NOW,
      id: `run-${index}`,
      startedAt: new Date(TODAY - (index + 40) * DAY_MS),
    }));

    await rollupWorkflowRuns(NOW.toISOString());

    expect(mocks.detectionPageSizes).toEqual([1_000, 1_000]);
    expect(mocks.pendingDirtyDays.length).toBeGreaterThan(0);
  });

  it('does not advance the sweep watermark when a day rebuild fails', async () => {
    mocks.recomputeDays = 1;
    mocks.runsPerDay = 1;
    mocks.failCreateMany = true;
    await expect(rollupWorkflowRuns(NOW.toISOString())).rejects.toThrow('createMany failed');
    expect(mocks.stateUpdates).toEqual([]);
    expect(mocks.lastSuccessfulStartAt).toBeNull();
  });

  it('detects a source change committed after the previous day read through the overlap', async () => {
    mocks.recomputeDays = 1;
    await rollupWorkflowRuns(NOW.toISOString());
    mocks.transactionDays = [];
    mocks.dirtyEndedRuns = [
      {
        endedAt: new Date(NOW.getTime() + 10 * 60_000),
        startedAt: new Date(TODAY - 50 * DAY_MS),
      },
    ];

    await rollupWorkflowRuns(new Date(NOW.getTime() + 30 * 60_000).toISOString());

    expect(mocks.transactionDays.map((day) => day.getTime())).toContain(TODAY - 50 * DAY_MS);
  });
});
