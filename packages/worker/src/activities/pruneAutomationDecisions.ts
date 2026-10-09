/**
 * The automation ledger's retention sweep (docs/automations.md): deletes event-automation
 * decisions that started no run once they are older than `workflow.automationDecisionRetentionDays`.
 *
 * `STARTED` decisions are never deleted: the same-subject and own-output guards read them, and a
 * pushed fix must stay recognised as the platform's own however old it is. Everything else —
 * suppressions, failed starts, decisions taken again — is history only, and grows with every
 * webhook. The setting's floor (7 days) keeps a decision at least as long as a host lets a
 * delivery be redelivered, so a redelivery still finds the decision and is not decided afresh.
 */
import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { logWarn } from '../lib/activityLog.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows deleted per statement, so one sweep never holds a long lock on a large table. */
export const PRUNE_BATCH = 2_000;
/** Batches per sweep; a backlog larger than this is finished by the following sweeps. */
export const PRUNE_MAX_BATCHES = 50;

export interface PruneAutomationDecisionsResult {
  deleted: number;
  retentionDays: number;
  /** True when the sweep stopped at its batch limit with older rows left. */
  more: boolean;
}

export async function pruneAutomationDecisions(
  now: Date = new Date()
): Promise<PruneAutomationDecisionsResult> {
  const retentionDays = await resolveSetting('workflow.automationDecisionRetentionDays', {});
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  // A row that names something the platform produced is own-output memory, kept like STARTED.
  const where = { createdAt: { lt: cutoff }, outcome: { not: 'STARTED' }, producedKey: null };
  let deleted = 0;
  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
    const ids = await prisma.automationFire.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true },
      take: PRUNE_BATCH,
      where,
    });
    if (ids.length === 0) {
      return { deleted, more: false, retentionDays };
    }
    // Re-checks the outcome: a row taken again since the read is still not STARTED, and a
    // STARTED row is never matched.
    const { count } = await prisma.automationFire.deleteMany({
      where: { ...where, id: { in: ids.map((r) => r.id) } },
    });
    deleted += count;
    if (ids.length < PRUNE_BATCH) {
      return { deleted, more: false, retentionDays };
    }
  }
  logWarn('automation decision sweep stopped at its batch limit; the next sweep continues', {
    deleted,
    retentionDays,
  });
  return { deleted, more: true, retentionDays };
}
