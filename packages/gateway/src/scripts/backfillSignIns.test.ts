import { describe, expect, it, vi } from 'vitest';
import { parseArgs, runBackfill } from './backfillSignIns.js';

type Audit = {
  id: string;
  actorId: string | null;
  afterJson: unknown;
  context: unknown;
  createdAt: Date;
};

function makeDb(audit: Audit[], events: Array<{ actorId: string; createdAt: Date }> = []) {
  const created: Array<Record<string, unknown>> = [];
  const auditFind = vi.fn(async (args: { take: number; where: Record<string, unknown> }) => {
    const sorted = [...audit].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)
    );
    const w = args.where as {
      OR?: Array<{ createdAt: { gt?: Date } | Date; id?: { gt: string } }>;
      createdAt?: { gte: Date };
    };
    let out = sorted;
    if (w.createdAt?.gte) {
      const gte = w.createdAt.gte;
      out = out.filter((r) => r.createdAt >= gte);
    }
    if (w.OR) {
      const [a, b] = w.OR as [{ createdAt: { gt: Date } }, { createdAt: Date; id: { gt: string } }];
      out = out.filter(
        (r) =>
          r.createdAt > a.createdAt.gt ||
          (r.createdAt.getTime() === b.createdAt.getTime() && r.id > b.id.gt)
      );
    }
    return out.slice(0, args.take);
  });
  const db = {
    configAuditLog: { findMany: auditFind },
    userActivityEvent: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        for (const d of data) {
          created.push(d);
          events.push({ actorId: d.actorId as string, createdAt: d.createdAt as Date });
        }
        return { count: data.length };
      }),
      findMany: vi.fn(async () => events),
    },
  };
  return { auditFind, created, db: db as never };
}

const NOW = new Date('2026-06-01T00:00:00Z');
const row = (n: number, over: Partial<Audit> = {}): Audit => ({
  actorId: 'u1',
  afterJson: { event: 'sign_in' },
  context: { ip: '203.0.113.0', via: 'session' },
  createdAt: new Date(NOW.getTime() - 3_600_000 + n * 60_000),
  id: `id-${String(n).padStart(4, '0')}`,
  ...over,
});
const opts = { log: () => {}, maxRows: 10_000, now: NOW, retentionDays: 90 };

describe('runBackfill', () => {
  it('writes the unknown-method shape from the audit row', async () => {
    const { db, created } = makeDb([row(1)]);
    const r = await runBackfill(db, { ...opts, dryRun: false });
    expect(r.inserted).toBe(1);
    expect(created[0]).toEqual({
      actorId: 'u1',
      createdAt: row(1).createdAt,
      ip: '203.0.113.0',
      kind: 'sign_in',
      method: 'AUTH',
      props: { backfilled: true, method: 'unknown' },
      route: 'auth:unknown',
      via: 'session',
    });
  });

  it('skips rows that have a method or no actor', async () => {
    const { db, created } = makeDb([
      row(1, { afterJson: { event: 'sign_in', method: 'password' } }),
      row(2, { actorId: null }),
      row(3, { context: null }),
    ]);
    const r = await runBackfill(db, { ...opts, dryRun: false });
    expect(r.ineligible).toBe(2);
    expect(created).toHaveLength(1);
    expect(created[0]?.ip).toBeNull();
  });

  it('dry run counts and writes nothing', async () => {
    const { db } = makeDb([row(1), row(2)]);
    const r = await runBackfill(db, { ...opts, dryRun: true });
    expect(r.inserted).toBe(2);
    expect(
      (db as { userActivityEvent: { createMany: unknown } }).userActivityEvent.createMany
    ).not.toHaveBeenCalled();
  });

  it('is idempotent: a second run adds nothing', async () => {
    const { db } = makeDb([row(1), row(5), row(9)]);
    expect((await runBackfill(db, { ...opts, dryRun: false })).inserted).toBe(3);
    const again = await runBackfill(db, { ...opts, dryRun: false });
    expect(again.inserted).toBe(0);
    expect(again.alreadyRecorded).toBe(3);
  });

  it('skips a row with an existing sign_in within 5s, not beyond', async () => {
    const t = row(1).createdAt;
    const { db, created } = makeDb(
      [row(1), row(2)],
      [{ actorId: 'u1', createdAt: new Date(t.getTime() + 4000) }]
    );
    const r = await runBackfill(db, { ...opts, dryRun: false });
    expect(r.alreadyRecorded).toBe(1);
    expect(created).toHaveLength(1);
  });

  it('restricts to the retention window', async () => {
    const { db, auditFind } = makeDb([]);
    await runBackfill(db, { ...opts, dryRun: true });
    const call = auditFind.mock.calls[0] as unknown as [{ where: { createdAt: { gte: Date } } }];
    const where = call[0].where;
    expect(where.createdAt.gte).toEqual(new Date(NOW.getTime() - 90 * 86_400_000));
  });

  it('pages in batches across the boundary without loss or repeats', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => row(i, { actorId: `u${i}` }));
    const { db, created, auditFind } = makeDb(rows);
    const r = await runBackfill(db, { ...opts, batchSize: 3, dryRun: false });
    expect(r.scanned).toBe(7);
    expect(created).toHaveLength(7);
    expect(auditFind).toHaveBeenCalledTimes(3);
  });

  it('stops at max rows', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i, { actorId: `u${i}` }));
    const { db } = makeDb(rows);
    const r = await runBackfill(db, { ...opts, batchSize: 3, dryRun: true, maxRows: 5 });
    expect(r.scanned).toBe(5);
    expect(r.hitMaxRows).toBe(true);
  });

  it('does not claim a stop when the cap equals the row count', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(i, { actorId: `u${i}` }));
    const { db } = makeDb(rows);
    const r = await runBackfill(db, { ...opts, batchSize: 3, dryRun: true, maxRows: 5 });
    expect(r.scanned).toBe(5);
    expect(r.hitMaxRows).toBe(false);
  });

  it('truncates the address copied from the audit context', async () => {
    const { db, created } = makeDb([row(1, { context: { ip: '203.0.113.77' } })]);
    await runBackfill(db, { ...opts, dryRun: false });
    expect(created[0]?.ip).toBe('203.0.113.0');
  });
});

describe('parseArgs', () => {
  it('parses flags and rejects junk', () => {
    expect(parseArgs(['--', '--dry-run', '--max-rows', '12'])).toEqual({
      dryRun: true,
      maxRows: 12,
    });
    expect(() => parseArgs(['--max-rows', 'x'])).toThrow();
    expect(() => parseArgs(['--nope'])).toThrow();
  });
});
