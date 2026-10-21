import { prisma } from '@auto-swe/shared/db';
import { logWarn } from './activityLog.js';

/**
 * The doors a worker-started run can come through. The gateway names its own in
 * `workflowLaunch.ts`; these are the ones with no request behind them.
 */
export type WorkerLaunchSource = 'channel-task' | 'epic-child' | 'prd-child';

export interface WorkerLaunchAudit {
  /** The launching user (`RunRequest.launchedById`), null when none is known. */
  actorId?: string | null;
  /** Fields merged into `afterJson`, beside `source`. */
  details: Record<string, unknown>;
  entityId: string;
  entityType: 'WorkflowRun' | 'WorkRequest';
  source: WorkerLaunchSource;
}

/**
 * One `CREATE` audit row for a run the worker started, where no gateway request exists to write
 * it. Same shape as the gateway's launch rows (`source` in `afterJson`) and, like every worker
 * writer, no `context`: there is no request to describe.
 *
 * Written at most once per entity and source: the existence check and the insert run in one
 * transaction under an advisory lock on that pair, so overlapping attempts (a retry racing a
 * slow first attempt) cannot both insert. Never throws — a failed audit write must not fail a
 * launched run.
 */
export async function recordWorkerLaunchAudit(audit: WorkerLaunchAudit): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      // CLAUDE.md §7 exception: Prisma cannot express a transaction-scoped advisory lock; it
      // serializes the check-then-insert for one entity and source.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`launch-audit:${audit.entityId}:${audit.source}`}, 0))`;
      const existing = await tx.configAuditLog.findFirst({
        select: { id: true },
        where: {
          action: 'CREATE',
          afterJson: { equals: audit.source, path: ['source'] },
          entityId: audit.entityId,
          entityType: audit.entityType,
        },
      });
      if (existing) {
        return;
      }
      await tx.configAuditLog.create({
        data: {
          action: 'CREATE',
          actorId: audit.actorId ?? null,
          // `source` last: a detail can never overwrite the door.
          afterJson: { ...audit.details, source: audit.source },
          entityId: audit.entityId,
          entityType: audit.entityType,
        },
      });
    });
  } catch (err) {
    logWarn('launch audit write failed — the run was launched', {
      entityId: audit.entityId,
      err: String(err),
      source: audit.source,
    });
  }
}
