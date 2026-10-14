import { describe, expect, it, vi } from 'vitest';

interface Row {
  id: string;
  status: 'PENDING' | 'DELIVERED' | 'DEAD';
  createdAt: Date;
}
const db = vi.hoisted(() => ({ rows: [] as Row[] }));

function matches(r: Row, where: Record<string, unknown>): boolean {
  const created = where.createdAt as { lt: Date };
  const status = where.status as { in: string[] };
  const ids = where.id as { in: string[] } | undefined;
  return (
    r.createdAt < created.lt && status.in.includes(r.status) && (!ids || ids.in.includes(r.id))
  );
}

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    configSetting: { findMany: vi.fn(async () => []) },
    outboundDelivery: {
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const before = db.rows.length;
        db.rows = db.rows.filter((r) => !matches(r, where));
        return { count: before - db.rows.length };
      }),
      findMany: vi.fn(async ({ take, where }: { take: number; where: Record<string, unknown> }) =>
        db.rows
          .filter((r) => matches(r, where))
          .slice(0, take)
          .map((r) => ({ id: r.id }))
      ),
    },
  },
}));
vi.mock('../lib/activityLog.js', () => ({ logError: vi.fn(), logWarn: vi.fn() }));

import { pruneCallbackDeliveries } from './pruneCallbackDeliveries.js';

describe('pruneCallbackDeliveries', () => {
  it('deletes old delivered and dead rows, and never a pending one', async () => {
    const now = new Date('2026-10-14T00:00:00Z');
    const old = new Date(now.getTime() - 40 * 86_400_000);
    const recent = new Date(now.getTime() - 5 * 86_400_000);
    db.rows = [
      { createdAt: old, id: 'old-delivered', status: 'DELIVERED' },
      { createdAt: old, id: 'old-dead', status: 'DEAD' },
      { createdAt: old, id: 'old-pending', status: 'PENDING' },
      { createdAt: recent, id: 'recent-dead', status: 'DEAD' },
    ];
    const result = await pruneCallbackDeliveries(now);
    expect(result).toEqual({ deleted: 2, more: false, retentionDays: 30 });
    expect(db.rows.map((r) => r.id).sort()).toEqual(['old-pending', 'recent-dead']);
  });
});
