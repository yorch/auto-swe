/**
 * The audit and activity retention sweep (docs/audit-log.md §3, docs/user-activity.md §5): deletes
 * `config_audit_log` rows past `audit.configLogRetentionDays` and `user_activity_events` rows past
 * `analytics.activityRetentionDays`.
 *
 * The audit log is kept forever unless an operator sets a retention (0, the default, disables its
 * half). When it does delete, the sweep writes one summary row of its own (system actor) naming the
 * count and the cutoff, so the deletion is itself on the record. Two kinds of row are never deleted
 * whatever their age: those summary rows (`AuditLogRetention`) and every change to a setting
 * (`ConfigSetting`), so the evidence of what the sweep removed, and of who set its retention, stays.
 * A sweep deletes at most `PRUNE_BATCH * PRUNE_MAX_BATCHES` rows per half and reports `more`; the
 * next scheduled run continues. Neither model is tenant-scoped, so no `runUnscoped`.
 */
import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { logWarn } from '../lib/activityLog.js';
import { PRUNE_BATCH, PRUNE_MAX_BATCHES } from './pruneAutomationDecisions.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The summary row's `entityId`: the log itself is the entity, and the column is a uuid. */
export const AUDIT_RETENTION_ENTITY_ID = '00000000-0000-0000-0000-000000000000';
export const AUDIT_RETENTION_ENTITY_TYPE = 'AuditLogRetention';
/** Audit entity types the sweep never deletes. */
export const AUDIT_PRUNE_EXEMPT_ENTITY_TYPES = [AUDIT_RETENTION_ENTITY_TYPE, 'ConfigSetting'];

export interface PruneAuditAndActivityResult {
  auditDeleted: number;
  /** 0 when audit retention is off. */
  auditRetentionDays: number;
  activityDeleted: number;
  activityRetentionDays: number;
  /** True when a half stopped at its batch limit with older rows left. */
  more: boolean;
}

/** Delete rows older than `cutoff` from one table in id batches; returns the count and `more`. */
async function deleteOlderThan(
  cutoff: Date,
  table: 'configAuditLog' | 'userActivityEvent',
  extraWhere: Record<string, unknown> = {}
): Promise<{ deleted: number; more: boolean }> {
  const model = prisma[table] as unknown as {
    deleteMany: (args: unknown) => Promise<{ count: number }>;
    findMany: (args: unknown) => Promise<Array<{ id: string }>>;
  };
  const where = { createdAt: { lt: cutoff }, ...extraWhere };
  let deleted = 0;
  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
    const ids = await model.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true },
      take: PRUNE_BATCH,
      where,
    });
    if (ids.length === 0) {
      return { deleted, more: false };
    }
    const { count } = await model.deleteMany({
      where: { ...where, id: { in: ids.map((r) => r.id) } },
    });
    deleted += count;
    if (ids.length < PRUNE_BATCH) {
      return { deleted, more: false };
    }
  }
  return { deleted, more: true };
}

export async function pruneAuditAndActivity(
  now: Date = new Date()
): Promise<PruneAuditAndActivityResult> {
  const auditRetentionDays = await resolveSetting('audit.configLogRetentionDays', {});
  const activityRetentionDays = await resolveSetting('analytics.activityRetentionDays', {});

  let auditDeleted = 0;
  let more = false;
  if (auditRetentionDays > 0) {
    const cutoff = new Date(now.getTime() - auditRetentionDays * DAY_MS);
    const result = await deleteOlderThan(cutoff, 'configAuditLog', {
      entityType: { notIn: AUDIT_PRUNE_EXEMPT_ENTITY_TYPES },
    });
    auditDeleted = result.deleted;
    more = result.more;
    if (auditDeleted > 0) {
      try {
        await prisma.configAuditLog.create({
          data: {
            action: 'DELETE',
            actorId: null,
            afterJson: {
              cutoff: cutoff.toISOString(),
              deleted: auditDeleted,
              more: result.more,
              retentionDays: auditRetentionDays,
            },
            beforeJson: null as never,
            entityId: AUDIT_RETENTION_ENTITY_ID,
            entityType: AUDIT_RETENTION_ENTITY_TYPE,
          },
        });
      } catch (err) {
        logWarn('audit retention summary row could not be written', {
          deleted: auditDeleted,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const activity = await deleteOlderThan(
    new Date(now.getTime() - activityRetentionDays * DAY_MS),
    'userActivityEvent'
  );
  more = more || activity.more;

  if (more) {
    logWarn('audit and activity sweep stopped at its batch limit; the next sweep continues', {
      activityDeleted: activity.deleted,
      auditDeleted,
    });
  }
  return {
    activityDeleted: activity.deleted,
    activityRetentionDays,
    auditDeleted,
    auditRetentionDays,
    more,
  };
}
