import type { PrismaClient } from '../generated/prisma/client.js';
import { runUnscoped } from './tenantGuard.js';

/** How long an expired or rejected plan is kept before the sweeper deletes it. */
export const DEFAULT_PLAN_RETENTION_MS = 7 * 24 * 3_600_000;
/** Plans one sweep expires and records; the next scheduled run continues past it. */
export const EXPIRE_BATCH = 500;

export interface ExpirePlansResult {
  expired: number;
  /** The plans this sweep moved to EXPIRED, for the audit rows the caller writes. */
  expiredIds: string[];
  deleted: number;
}

/**
 * The run-plan sweeper: PENDING and APPROVED-but-unlaunched plans past their expiry become
 * EXPIRED, and EXPIRED or REJECTED plans older than the retention window are deleted. Cross-tenant
 * by nature, so every query is marked `runUnscoped`. LAUNCHED plans are never touched: a run names
 * them.
 *
 * The ids come from a read, then the write names them with the same predicates again, then a read
 * confirms which are now EXPIRED: an approval that extended a plan's expiry between the two steps
 * keeps its plan out of both the update and the list.
 */
export async function expireRunPlans(
  prisma: Pick<PrismaClient, 'runPlan'>,
  now: Date,
  opts: { retentionMs?: number } = {}
): Promise<ExpirePlansResult> {
  const cutoff = new Date(now.getTime() - (opts.retentionMs ?? DEFAULT_PLAN_RETENTION_MS));
  const due = await runUnscoped(
    'the plan sweeper finds stale plans of every team',
    ['RunPlan'],
    () =>
      prisma.runPlan.findMany({
        orderBy: { expiresAt: 'asc' },
        select: { id: true },
        take: EXPIRE_BATCH,
        where: { expiresAt: { lte: now }, status: { in: ['PENDING', 'APPROVED'] } },
      })
  );
  let expiredIds: string[] = [];
  if (due.length > 0) {
    const ids = due.map((r) => r.id);
    await runUnscoped('the plan sweeper expires stale plans of every team', ['RunPlan'], () =>
      prisma.runPlan.updateMany({
        data: { status: 'EXPIRED' },
        where: {
          expiresAt: { lte: now },
          id: { in: ids },
          status: { in: ['PENDING', 'APPROVED'] },
        },
      })
    );
    const confirmed = await runUnscoped(
      'the plan sweeper confirms which plans it expired',
      ['RunPlan'],
      () =>
        prisma.runPlan.findMany({
          select: { id: true },
          where: { id: { in: ids }, status: 'EXPIRED' },
        })
    );
    expiredIds = confirmed.map((r) => r.id);
  }
  const deleted = await runUnscoped(
    'the plan sweeper deletes old expired and rejected plans of every team',
    ['RunPlan'],
    () =>
      prisma.runPlan.deleteMany({
        where: { createdAt: { lt: cutoff }, status: { in: ['EXPIRED', 'REJECTED'] } },
      })
  );
  return { deleted: deleted.count, expired: expiredIds.length, expiredIds };
}
