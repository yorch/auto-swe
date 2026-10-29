import { TX_TIMEOUT_MS } from '@auto-swe/shared/lib/agentTraceRollup';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-20T12:00:00.000Z');
const TODAY = Date.parse('2026-10-20T00:00:00.000Z');

const mocks = vi.hoisted(() => ({
  backfillDays: 0,
  built: [] as Array<{ builtAt: Date | null; day: Date }>,
  createManySizes: [] as number[],
  dirtyEndedRuns: [] as Array<{ endedAt: Date; startedAt: Date }>,
  dirtyPullRequests: [] as Array<{
    closedAt: Date | null;
    mergedAt: Date | null;
    run: { startedAt: Date };
  }>,
  events: [] as string[],
  failCreateMany: false,
  lastSuccessfulStartAt: null as Date | null,
  oldest: null as Date | null,
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
      agentTrace: { findMany: async () => [] },
      pullRequest: { findMany: async () => mocks.dirtyPullRequests },
      rollupSweepState: {
        findUnique: async () =>
          mocks.lastSuccessfulStartAt
            ? { lastSuccessfulStartAt: mocks.lastSuccessfulStartAt }
            : null,
        updateMany: async ({ data }: { data: { lastSuccessfulStartAt: Date } }) => {
          mocks.lastSuccessfulStartAt = data.lastSuccessfulStartAt;
          mocks.stateUpdates.push(data.lastSuccessfulStartAt);
          return { count: 1 };
        },
        upsert: async ({ create }: { create: { lastSuccessfulStartAt: Date; name: string } }) => {
          mocks.lastSuccessfulStartAt ??= create.lastSuccessfulStartAt;
          return { name: create.name };
        },
      },
      workflowHumanStep: { findMany: async () => [] },
      workflowRun: {
        aggregate: async () => ({ _min: { startedAt: mocks.oldest } }),
        findMany: async ({
          where,
        }: {
          where: {
            endedAt?: unknown;
            startedAt?: { gte?: Date; lt?: Date };
          };
        }) => {
          if (where.endedAt) {
            return mocks.dirtyEndedRuns;
          }
          const day = where.startedAt?.gte;
          if (!day) {
            return [];
          }
          mocks.events.push(`read:${day.toISOString().slice(0, 10)}`);
          return Array.from({ length: mocks.runsPerDay }, (_, index) => ({
            attributedOrgId: 'org',
            attributedTeamId: 'team',
            connectionId: `repo-${index}`,
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
      workflowStep: { findMany: async () => [] },
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
  mocks.dirtyPullRequests = [];
  mocks.failCreateMany = false;
  mocks.lastSuccessfulStartAt = null;
  mocks.oldest = null;
  mocks.present = [];
  mocks.recomputeDays = 2;
  mocks.runsPerDay = 0;
  mocks.stateUpdates = [];
  mocks.transactionDays = [];
  mocks.transactionOptions = [];
  mocks.createManySizes = [];
});

describe('rollupWorkflowRuns', () => {
  it('reads only the selected completed days', async () => {
    const result = await rollupWorkflowRuns(NOW);
    expect(result.days).toBe(2);
    expect(mocks.events.filter((event) => event.startsWith('read:'))).toEqual([
      `read:${new Date(TODAY - 2 * DAY_MS).toISOString().slice(0, 10)}`,
      `read:${new Date(TODAY - DAY_MS).toISOString().slice(0, 10)}`,
    ]);
  });

  it('caps historical backfill work per sweep', async () => {
    mocks.backfillDays = 365;
    mocks.oldest = new Date(TODAY - 500 * DAY_MS);
    const result = await rollupWorkflowRuns(NOW);
    expect(result.days).toBe(2 + MAX_BACKFILL_DAYS_PER_SWEEP);
  });

  it('replaces each day in a bounded transaction and chunks large inserts', async () => {
    mocks.recomputeDays = 1;
    mocks.runsPerDay = 501;
    const result = await rollupWorkflowRuns(NOW);
    expect(result.rows).toBe(501);
    expect(mocks.createManySizes).toEqual([500, 1]);
    expect(mocks.transactionDays).toEqual([new Date(TODAY - DAY_MS)]);
    expect(mocks.transactionOptions).toEqual([{ maxWait: 30_000, timeout: TX_TIMEOUT_MS }]);
  });

  it('heartbeats before and after every selected day', async () => {
    await rollupWorkflowRuns(NOW);
    expect(mocks.events.filter((event) => event.startsWith('heartbeat:'))).toEqual([
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
    const result = await rollupWorkflowRuns(NOW);
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
    const result = await rollupWorkflowRuns(NOW);
    expect(result.days).toBe(3);
    expect(mocks.transactionDays.map((day) => day.getTime())).toContain(TODAY - 45 * DAY_MS);
    expect(mocks.stateUpdates).toEqual([NOW]);
  });

  it('caps dirty-day work at sixty and leaves the sweep watermark unchanged', async () => {
    mocks.lastSuccessfulStartAt = new Date('2026-10-19T00:00:00.000Z');
    mocks.dirtyEndedRuns = Array.from({ length: 61 }, (_, index) => ({
      endedAt: new Date('2026-10-20T10:00:00.000Z'),
      startedAt: new Date(TODAY - (index + 40) * DAY_MS),
    }));
    const result = await rollupWorkflowRuns(NOW);
    expect(result.days).toBe(2 + MAX_DIRTY_DAYS_PER_SWEEP);
    expect(mocks.stateUpdates).toEqual([]);
    expect(mocks.lastSuccessfulStartAt).toEqual(new Date('2026-10-19T00:00:00.000Z'));
  });

  it('does not advance the sweep watermark when a day rebuild fails', async () => {
    mocks.recomputeDays = 1;
    mocks.runsPerDay = 1;
    mocks.failCreateMany = true;
    await expect(rollupWorkflowRuns(NOW)).rejects.toThrow('createMany failed');
    expect(mocks.stateUpdates).toEqual([]);
    expect(mocks.lastSuccessfulStartAt).toBeNull();
  });
});
