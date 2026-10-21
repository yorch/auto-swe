import { beforeEach, describe, expect, it, vi } from 'vitest';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-20T12:00:00.000Z');
const TODAY = Date.parse('2026-10-20T00:00:00.000Z');

const mocks = vi.hoisted(() => ({
  backfillDays: 0,
  events: [] as string[],
  invalid: [] as string[],
  oldest: null as Date | null,
  present: [] as Date[],
  rolled: [] as number[],
}));
vi.mock('@temporalio/activity', () => ({
  heartbeat: (d: string) => mocks.events.push(`heartbeat:${d}`),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    agentTrace: { aggregate: async () => ({ _min: { createdAt: mocks.oldest } }) },
    agentTraceDailyUsage: { groupBy: async () => mocks.present.map((day) => ({ day })) },
  },
}));
vi.mock('@auto-swe/shared/lib/agentTraceRollup', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/agentTraceRollup')>()),
  rollupUsageDay: async (_p: unknown, dayMs: number) => {
    mocks.rolled.push(dayMs);
    mocks.events.push(`day:${new Date(dayMs).toISOString().slice(0, 10)}`);
    return { day: new Date(dayMs).toISOString().slice(0, 10), rows: 2 };
  },
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveScheduledSweeps: () => ({ agentTraceRollup: { backfillDays: mocks.backfillDays } }),
  validateScheduledSweepsEnv: () => mocks.invalid,
}));
const logWarn = vi.hoisted(() => vi.fn());
vi.mock('../lib/activityLog.js', () => ({ logWarn }));

import { MAX_BACKFILL_DAYS_PER_SWEEP, rollupAgentTraceUsage } from './rollupAgentTraceUsage.js';

beforeEach(() => {
  mocks.backfillDays = 0;
  mocks.oldest = null;
  mocks.present = [];
  mocks.rolled = [];
  mocks.events = [];
  mocks.invalid = [];
  logWarn.mockClear();
});

describe('rollupAgentTraceUsage', () => {
  it('fits its workflow timeout with headroom: 2 + the backfill limit, at the transaction ceiling', async () => {
    const { TX_TIMEOUT_MS } = await import('@auto-swe/shared/lib/agentTraceRollup');
    const worstCaseMs = (2 + MAX_BACKFILL_DAYS_PER_SWEEP) * TX_TIMEOUT_MS;
    const workflowTimeoutMs = 90 * 60 * 1000; // T_90M in scheduledAgentTraceRollup.ts
    expect(worstCaseMs).toBeLessThan(workflowTimeoutMs);
  });

  it('rewrites the last two completed days, and nothing else, by default', async () => {
    const r = await rollupAgentTraceUsage(NOW);
    expect(mocks.rolled).toEqual([TODAY - DAY_MS, TODAY - 2 * DAY_MS]);
    expect(r).toMatchObject({ backfilled: 0, more: false, rows: 4 });
  });

  it('backfills days with no rollup, newest first, skipping those that have one', async () => {
    mocks.backfillDays = 10;
    mocks.oldest = new Date(TODAY - 30 * DAY_MS);
    mocks.present = [new Date(TODAY - 4 * DAY_MS)];
    const r = await rollupAgentTraceUsage(NOW);
    const backfilled = mocks.rolled.slice(2);
    expect(backfilled[0]).toBe(TODAY - 3 * DAY_MS);
    expect(backfilled).not.toContain(TODAY - 4 * DAY_MS);
    expect(backfilled.at(-1)).toBe(TODAY - 10 * DAY_MS);
    expect(r.backfilled).toBe(backfilled.length);
    expect(r.more).toBe(false);
  });

  it('does not reach back past the oldest trace', async () => {
    mocks.backfillDays = 100;
    mocks.oldest = new Date(TODAY - 5 * DAY_MS + 3_600_000);
    await rollupAgentTraceUsage(NOW);
    expect(Math.min(...mocks.rolled)).toBe(TODAY - 5 * DAY_MS);
  });

  it('stops at its per-sweep limit and says more remain', async () => {
    mocks.backfillDays = 365;
    mocks.oldest = new Date(TODAY - 365 * DAY_MS);
    const r = await rollupAgentTraceUsage(NOW);
    expect(r.backfilled).toBe(MAX_BACKFILL_DAYS_PER_SWEEP);
    expect(r.more).toBe(true);
  });

  it('heartbeats before each day, so a slow multi-day sweep is seen to be alive', async () => {
    await rollupAgentTraceUsage(NOW);
    expect(mocks.events).toEqual([
      'heartbeat:rolling up 2026-10-19',
      'day:2026-10-19',
      'heartbeat:rolling up 2026-10-18',
      'day:2026-10-18',
    ]);
  });

  it('says so loudly when the backfill variable is unusable, and backfills nothing', async () => {
    mocks.invalid = ['AGENT_TRACE_ROLLUP_BACKFILL_DAYS="-1" is not a whole number of days'];
    await rollupAgentTraceUsage(NOW);
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining('invalid AGENT_TRACE_ROLLUP_BACKFILL_DAYS'),
      expect.anything()
    );
    expect(mocks.rolled).toHaveLength(2);
  });

  it('backfills nothing when there are no traces at all', async () => {
    mocks.backfillDays = 30;
    await rollupAgentTraceUsage(NOW);
    expect(mocks.rolled).toHaveLength(2);
  });
});
