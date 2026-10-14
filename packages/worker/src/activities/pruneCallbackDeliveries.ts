/**
 * The run-callback outbox's retention sweep (docs/run-callbacks.md): deletes
 * delivered and dead deliveries once they are older than
 * `workflow.callbackDeliveryRetentionDays`. Pending rows are never deleted —
 * the delivery sweep still owns them, and a pending row older than the
 * retention is one still inside a redelivery's retry window.
 */
import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { logWarn } from '../lib/activityLog.js';
import { PRUNE_BATCH, PRUNE_MAX_BATCHES } from './pruneAutomationDecisions.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneCallbackDeliveriesResult {
  deleted: number;
  retentionDays: number;
  /** True when the sweep stopped at its batch limit with older rows left. */
  more: boolean;
}

export async function pruneCallbackDeliveries(
  now: Date = new Date()
): Promise<PruneCallbackDeliveriesResult> {
  const retentionDays = await resolveSetting('workflow.callbackDeliveryRetentionDays', {});
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const where = {
    createdAt: { lt: cutoff },
    status: { in: ['DELIVERED' as const, 'DEAD' as const] },
  };
  let deleted = 0;
  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
    const ids = await prisma.outboundDelivery.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true },
      take: PRUNE_BATCH,
      where,
    });
    if (ids.length === 0) {
      return { deleted, more: false, retentionDays };
    }
    // Re-checks the status: a row redelivered since the read is PENDING again and is kept.
    const { count } = await prisma.outboundDelivery.deleteMany({
      where: { ...where, id: { in: ids.map((r) => r.id) } },
    });
    deleted += count;
    if (ids.length < PRUNE_BATCH) {
      return { deleted, more: false, retentionDays };
    }
  }
  logWarn('callback delivery sweep stopped at its batch limit; the next sweep continues', {
    deleted,
    retentionDays,
  });
  return { deleted, more: true, retentionDays };
}
