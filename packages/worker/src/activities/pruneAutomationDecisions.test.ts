import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Row {
  id: string;
  outcome: string;
  createdAt: Date;
  producedKey?: string | null;
}
const db = vi.hoisted(() => ({ rows: [] as Row[] }));

/** The subset of Prisma's `where` the sweep writes, evaluated against a row. */
function matches(r: Row, where: Record<string, unknown>): boolean {
  const created = where.createdAt as { lt: Date };
  const outcome = where.outcome as { not: string };
  const ids = where.id as { in: string[] } | undefined;
  const produced = where.producedKey === null ? (r.producedKey ?? null) === null : true;
  return (
    r.createdAt < created.lt &&
    r.outcome !== outcome.not &&
    produced &&
    (!ids || ids.in.includes(r.id))
  );
}

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    automationFire: {
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const before = db.rows.length;
        db.rows = db.rows.filter((r) => !matches(r, where));
        return { count: before - db.rows.length };
      }),
      findMany: vi.fn(async ({ take, where }: { take: number; where: Record<string, unknown> }) =>
        db.rows
          .filter((r) => matches(r, where))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, take)
          .map((r) => ({ id: r.id }))
      ),
    },
  },
}));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: vi.fn(async () => 90) }));
const logWarn = vi.fn();
vi.mock('../lib/activityLog.js', () => ({ logWarn: (...a: unknown[]) => logWarn(...a) }));

import {
  PRUNE_BATCH,
  PRUNE_MAX_BATCHES,
  pruneAutomationDecisions,
} from './pruneAutomationDecisions.js';

const NOW = new Date('2026-10-01T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

beforeEach(() => {
  vi.clearAllMocks();
  db.rows = [];
});

describe('pruneAutomationDecisions', () => {
  it('deletes only decisions past retention that started no run', async () => {
    db.rows = [
      { createdAt: daysAgo(400), id: 'old-started', outcome: 'STARTED' },
      { createdAt: daysAgo(100), id: 'old-cooldown', outcome: 'SUPPRESSED_COOLDOWN' },
      { createdAt: daysAgo(91), id: 'old-failed', outcome: 'FAILED_TO_START' },
      { createdAt: daysAgo(30), id: 'recent-cooldown', outcome: 'SUPPRESSED_COOLDOWN' },
      {
        createdAt: daysAgo(400),
        id: 'old-own-fix',
        outcome: 'SUPPRESSED_OWN_OUTPUT',
        producedKey: 'a'.repeat(40),
      },
    ];
    await expect(pruneAutomationDecisions(NOW)).resolves.toEqual({
      deleted: 2,
      more: false,
      retentionDays: 90,
    });
    // A row naming a commit the platform produced is kept: the own-output guard reads it.
    expect(db.rows.map((r) => r.id)).toEqual(['old-started', 'recent-cooldown', 'old-own-fix']);
  });

  it('stops at its batch limit and says more is left', async () => {
    // An endless backlog: every read finds a full batch.
    const { prisma } = await import('@auto-swe/shared/db');
    vi.mocked(prisma.automationFire.findMany).mockImplementation((async () =>
      Array.from({ length: PRUNE_BATCH }, (_, i) => ({ id: `r${i}` }))) as never);
    vi.mocked(prisma.automationFire.deleteMany).mockImplementation((async ({
      where,
    }: {
      where: { id: { in: string[] } };
    }) => ({ count: where.id.in.length })) as never);
    const result = await pruneAutomationDecisions(NOW);
    expect(result).toMatchObject({ deleted: PRUNE_BATCH * PRUNE_MAX_BATCHES, more: true });
    expect(prisma.automationFire.deleteMany).toHaveBeenCalledTimes(PRUNE_MAX_BATCHES);
    expect(logWarn).toHaveBeenCalled();
  });
});
