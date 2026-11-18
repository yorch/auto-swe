/**
 * The run-plan sweep (docs/specs/2026-11-17-launch-time-workflow-generation.md, section 6):
 * PENDING and unlaunched APPROVED plans past their expiry become EXPIRED, and EXPIRED or REJECTED
 * plans past the retention window are deleted, and LAUNCHED plans past `runPlans.launchedRetentionDays`
 * are scrubbed (goal and plan body removed, row kept). The logic is `expireRunPlans` in shared; this
 * activity adds the audit row for each plan it expired or scrubbed (system actor, ids, mode and team
 * only, no plan content). A failed audit write is logged and never fails the sweep.
 */
import { prisma } from '@auto-swe/shared/db';
import { expireRunPlans } from '@auto-swe/shared/lib/runPlanSweep';
import { logWarn } from '../lib/activityLog.js';

export interface SweepRunPlansResult {
  expired: number;
  deleted: number;
  scrubbed: number;
}

export async function sweepRunPlans(now: Date = new Date()): Promise<SweepRunPlansResult> {
  const result = await expireRunPlans(prisma, now);
  if (result.expiredIds.length > 0) {
    try {
      await prisma.configAuditLog.createMany({
        data: result.expiredIds.map((id) => ({
          action: 'UPDATE' as const,
          actorId: null,
          afterJson: { event: 'run_plan.expired', status: 'EXPIRED' },
          beforeJson: { status: 'PENDING_OR_APPROVED' },
          entityId: id,
          entityType: 'RunPlan',
        })),
      });
    } catch (err) {
      logWarn('run plan expiry audit rows could not be written', {
        error: err instanceof Error ? err.message : String(err),
        expired: result.expiredIds.length,
      });
    }
  }
  if (result.scrubbed.length > 0) {
    try {
      await prisma.configAuditLog.createMany({
        data: result.scrubbed.map((plan) => ({
          action: 'UPDATE' as const,
          actorId: null,
          afterJson: {
            event: 'run_plan.scrubbed',
            mode: plan.mode,
            status: 'LAUNCHED',
            teamId: plan.teamId,
          },
          beforeJson: { status: 'LAUNCHED' },
          entityId: plan.id,
          entityType: 'RunPlan',
        })),
      });
    } catch (err) {
      logWarn('run plan scrub audit rows could not be written', {
        error: err instanceof Error ? err.message : String(err),
        scrubbed: result.scrubbed.length,
      });
    }
  }
  return { deleted: result.deleted, expired: result.expired, scrubbed: result.scrubbed.length };
}
