import { describe, expect, it } from 'vitest';
import { attributeLauncher, rollupUsageDay } from './agentTraceRollup.js';

const DAY = Date.parse('2026-10-10T00:00:00.000Z');

/**
 * A stand-in for the pieces of Prisma `rollupUsageDay` touches, with READ COMMITTED visibility and
 * a real advisory-lock queue: a transaction's inserts become visible to others only at commit, and
 * `pg_advisory_xact_lock` waits for the holder to commit.
 */
function fakeDb(traceDelayMs = 5) {
  const committed: Record<string, unknown>[] = [];
  const events: string[] = [];
  const held = new Map<string, Promise<void>>();
  const trace = {
    _count: { _all: 1, durationMs: 1 },
    _sum: { costUsd: 0.1234567891, durationMs: 10, inputTokens: 3, outputTokens: 4 },
    agentKey: 'a',
    model: 'm',
    nodeId: 'n',
    orgId: null,
    runId: null,
    teamId: null,
    temporalRunId: null,
  };
  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<number>) => {
      const staged: Record<string, unknown>[] = [];
      let release: () => void = () => undefined;
      const mine = new Promise<void>((r) => {
        release = r;
      });
      const tx = {
        $executeRaw: async (_s: TemplateStringsArray, key: string) => {
          events.push('lock');
          const prev = held.get(key);
          held.set(key, mine);
          await prev;
        },
        agentTrace: {
          groupBy: async (a: { where: { error?: unknown } }) => {
            await new Promise((r) => setTimeout(r, traceDelayMs));
            return a.where.error ? [] : [trace];
          },
        },
        agentTraceDailyUsage: {
          createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
            events.push('create');
            staged.push(...data);
            // The window between the insert and the commit, where an unlocked rival's delete
            // finds nothing of ours to remove.
            await new Promise((r) => setTimeout(r, traceDelayMs * 3));
          },
          deleteMany: async () => {
            events.push('delete');
            committed.length = 0;
          },
        },
        workflowRun: { findMany: async () => [] },
      };
      try {
        const out = await fn(tx);
        committed.push(...staged);
        return out;
      } finally {
        release();
      }
    },
  };
  return { committed, events, prisma: prisma as never };
}

describe('rollupUsageDay', () => {
  it('takes the day lock before it deletes or inserts anything', async () => {
    const db = fakeDb();
    await rollupUsageDay(db.prisma, DAY);
    expect(db.events).toEqual(['lock', 'delete', 'create']);
  });

  it('does not duplicate a day when two rewrites of it overlap', async () => {
    const db = fakeDb();
    await Promise.all([rollupUsageDay(db.prisma, DAY), rollupUsageDay(db.prisma, DAY)]);
    expect(db.committed).toHaveLength(1);
  });

  it('keeps a cost that is not exact to six places', async () => {
    const db = fakeDb();
    await rollupUsageDay(db.prisma, DAY);
    expect(Number(db.committed[0]?.costUsd)).toBeCloseTo(0.1234567891, 10);
  });

  it('refuses a time that is not a UTC midnight', async () => {
    await expect(rollupUsageDay(fakeDb().prisma, DAY + 1)).rejects.toThrow(/UTC midnight/);
  });
});

describe('attributeLauncher', () => {
  const run = { launchedById: 'u', temporalRunId: 't1' };
  it('trusts the run row only for the execution that wrote it', () => {
    expect(attributeLauncher(run, 't1')).toBe('u');
    expect(attributeLauncher(run, 't2')).toBeNull();
    expect(attributeLauncher(run, null)).toBeNull();
    expect(attributeLauncher(undefined, 't1')).toBeNull();
  });
});
