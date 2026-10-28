/**
 * The run-history retention sweep (docs/architecture.md, "Run history retention"): deletes finished
 * `WorkflowRun` rows that ended more than `workflow.runRetentionDays` ago. `0`, the default, keeps
 * every run forever and the sweep reads nothing.
 *
 * Deleting a run cascades (database side) to its steps, traces, artifacts, human steps and their
 * approvals, eval results, outcome references, autonomy decisions, trusted-knowledge evidence and
 * callback deliveries. It sets null on memory items and agent transcripts, which therefore survive;
 * rollup rows, the transcript access log, pull requests, work requests and the `ActiveWorkflow`
 * ledger have no foreign key to a run and are untouched.
 *
 * A finished run is still kept when deleting it would lose something another feature needs, and the
 * sweep says how many it kept and why:
 *  - `held`: its `ActiveWorkflow` row is not terminal (a reused workflow id has a newer execution,
 *    or the run is parked) or has an OPEN pull request (PR feedback reads the run that opened it);
 *  - `pendingCallback`: a run callback for it is still PENDING (the cascade would drop it unsent);
 *  - `unrolledSpend`: it has LLM traces but no usage-rollup row, so deleting it would erase its
 *    spend from the report (days without a rollup are read live from the traces);
 *  - `storageFailed`: an object-store artifact could not be deleted first, which would otherwise
 *    orphan the object (the cascade removes only the row).
 * A run under a transcript legal hold is never selected.
 *
 * Batches are small (a run cascades to thousands of trace rows) and walked by keyset on
 * (`startedAt`, `id`), so runs
 * that are kept do not hold the front of the queue. A failing batch is logged and ends the sweep;
 * it never throws. The next scheduled sweep continues.
 */
import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { deleteArtifact } from '@auto-swe/shared/lib/artifactStore';
import { resolveStorageConfig } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { ACTIVE_WORKFLOW_TERMINAL_STATUSES } from '@auto-swe/shared/types/api';
import { heartbeat } from '@temporalio/activity';
import { auditLog, logWarn } from '../lib/activityLog.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Runs deleted per statement; each cascades to its traces, so this is far below the siblings'. */
export const RUN_PRUNE_BATCH = 100;
/** Runs deleted per sweep; a backlog larger than this is finished by the following sweeps. */
export const RUN_PRUNE_MAX_DELETED = 10_000;
/** Batches read per sweep, kept runs included: a hard bound so the loop always ends. */
export const RUN_PRUNE_MAX_BATCHES = 5_000;
/**
 * Wall-clock budget per sweep. It is checked between batches and artifacts, so it does not bound a
 * single heavy statement: it leaves headroom under the workflow's 10-minute `startToCloseTimeout`
 * for one worst-case batch, and the heartbeat is what stops an attempt that overruns anyway.
 */
export const RUN_PRUNE_BATCH_BUDGET_MS = 6 * 60 * 1000;
/** The run statuses that mean the run has ended (everything but RUNNING). */
export const RUN_TERMINAL_STATUSES = [
  'SUCCESS',
  'FAILED',
  'TIMED_OUT',
  'SKIPPED',
  'CANCELLED',
] as const;

export interface PruneRunHistoryKept {
  held: number;
  pendingCallback: number;
  unrolledSpend: number;
  storageFailed: number;
}

export interface PruneRunHistoryResult {
  deleted: number;
  /** 0 when run retention is off. */
  retentionDays: number;
  /** Finished runs past retention that were kept this sweep, by reason. */
  kept: PruneRunHistoryKept;
  /** True when the sweep stopped at one of its limits, or on an error, with older runs left. */
  more: boolean;
}

function finishedBefore(cutoff: Date, objectStore: boolean) {
  // `startedAt` is implied by `endedAt` (a run ends after it starts) but is the indexed column
  // (`status, started_at`); stating it lets the query walk that index instead of scanning.
  //
  // `steps` and `traces`: a workflow id that is started again keeps its first execution's terminal
  // status and `endedAt` (`createWorkflowRun` rewrites neither, and `finalizeRun` skips a run that
  // already ended), so a live second execution can look old and finished. Any step started or trace
  // written since the cutoff shows it is not.
  return {
    // No object store: such a run's objects cannot be deleted, so it could only ever be kept.
    ...(objectStore ? {} : { artifacts: { none: { backend: 's3' } } }),
    endedAt: { lt: cutoff },
    startedAt: { lt: cutoff },
    status: { in: [...RUN_TERMINAL_STATUSES] },
    steps: { none: { startedAt: { gte: cutoff } } },
    traces: { none: { createdAt: { gte: cutoff } } },
    transcriptLegalHold: false,
  };
}

export async function pruneRunHistory(
  now: Date = new Date(),
  /** Milliseconds, monotonic; injectable so the budget can be tested without waiting. */
  clock: () => number = () => performance.now()
): Promise<PruneRunHistoryResult> {
  let retentionDays = 0;
  const kept: PruneRunHistoryKept = {
    held: 0,
    pendingCallback: 0,
    storageFailed: 0,
    unrolledSpend: 0,
  };
  let deleted = 0;
  try {
    retentionDays = await resolveSetting('workflow.runRetentionDays', {});
    if (retentionDays <= 0) {
      return { deleted: 0, kept, more: false, retentionDays };
    }
    const objectStore = resolveStorageConfig().backend === 's3';
    if (!objectStore) {
      logWarn(
        'run history sweep: no object store is configured, so runs with object-store artifacts are not considered',
        { retentionDays }
      );
    }
    const where = finishedBefore(new Date(now.getTime() - retentionDays * DAY_MS), objectStore);
    const deadline = clock() + RUN_PRUNE_BATCH_BUDGET_MS;
    const expired = () => clock() >= deadline;
    // Ids kept (and counted) by the previous batch. `startedAt` is read at millisecond precision, so
    // the run a batch ended on can be read again as the next one's first; it is not counted twice.
    let previousKept = new Set<string>();
    // Keyset position: the sort values of the last run read. A cursor on its id would fail once that
    // run was deleted (the row Prisma derives the position from is gone and the read returns nothing).
    let last: { id: string; startedAt: Date } | undefined;
    for (
      let batch = 0;
      batch < RUN_PRUNE_MAX_BATCHES && deleted < RUN_PRUNE_MAX_DELETED && !expired();
      batch++
    ) {
      // A heartbeat each batch: an attempt Temporal has timed out or cancelled learns it here.
      heartbeat(`run history batch ${batch}`);
      const take = Math.min(RUN_PRUNE_BATCH, RUN_PRUNE_MAX_DELETED - deleted);
      const runs = await prisma.workflowRun.findMany({
        orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
        select: { id: true, startedAt: true, workflowId: true },
        take,
        where: last
          ? {
              ...where,
              OR: [
                { startedAt: { gt: last.startedAt } },
                { id: { gt: last.id }, startedAt: last.startedAt },
              ],
            }
          : where,
      });
      if (runs.length === 0) {
        return finish(deleted, retentionDays, kept, false);
      }
      const end = runs[runs.length - 1];
      if (
        end &&
        last &&
        end.id === last.id &&
        end.startedAt.getTime() === last.startedAt.getTime()
      ) {
        // The read made no progress (a boundary run re-read with nothing after it): stop rather
        // than spin; the next sweep starts afresh.
        logWarn('run history sweep stopped: a batch ended where the previous one did', {
          deleted,
          retentionDays,
        });
        return finish(deleted, retentionDays, kept, true);
      }
      last = end;
      const result = await deleteBatch(runs, where, kept, previousKept, expired);
      deleted += result.deleted;
      previousKept = result.keptIds;
      // A short batch is the end of the queue, unless time ran out inside it and some of its runs
      // were left for the next sweep.
      if (runs.length < take && !expired()) {
        return finish(deleted, retentionDays, kept, false);
      }
    }
    logWarn('run history sweep stopped at its limit; the next sweep continues', {
      deleted,
      retentionDays,
    });
    return finish(deleted, retentionDays, kept, true);
  } catch (err) {
    logWarn('run history sweep failed; the next sweep continues', {
      deleted,
      error: err instanceof Error ? err.message : String(err),
      retentionDays,
    });
    return finish(deleted, retentionDays, kept, true);
  }
}

function finish(
  deleted: number,
  retentionDays: number,
  kept: PruneRunHistoryKept,
  more: boolean
): PruneRunHistoryResult {
  if (
    deleted > 0 ||
    kept.held + kept.pendingCallback + kept.unrolledSpend + kept.storageFailed > 0
  ) {
    auditLog(
      `run history sweep: deleted ${deleted} finished runs older than ${retentionDays} days; kept ${JSON.stringify(kept)}${more ? '; more remain' : ''}`
    );
  }
  return { deleted, kept, more, retentionDays };
}

/**
 * Deletes the runs of one batch that nothing still needs. Returns how many went and the ids it
 * kept, so the next batch does not count a boundary run it reads again.
 */
async function deleteBatch(
  runs: Array<{ id: string; workflowId: string }>,
  where: ReturnType<typeof finishedBefore>,
  kept: PruneRunHistoryKept,
  previousKept: Set<string>,
  expired: () => boolean
): Promise<{ deleted: number; keptIds: Set<string> }> {
  const ids = runs.map((r) => r.id);
  const byWorkflowId = new Map(runs.map((r) => [r.workflowId, r.id]));

  const [ledger, callbacks, traced, rolled] = await Promise.all([
    prisma.activeWorkflow.findMany({
      select: { temporalWorkflowId: true },
      where: {
        OR: [
          { currentStatus: { notIn: [...ACTIVE_WORKFLOW_TERMINAL_STATUSES] } },
          { pullRequests: { some: { status: 'OPEN' } } },
        ],
        temporalWorkflowId: { in: [...byWorkflowId.keys()] },
      },
    }),
    prisma.outboundDelivery.findMany({
      distinct: ['workflowRunId'],
      select: { workflowRunId: true },
      where: { status: 'PENDING', workflowRunId: { in: ids } },
    }),
    runUnscoped('run history sweep asks which runs recorded LLM calls', ['AgentTrace'], () =>
      prisma.agentTrace.groupBy({
        by: ['runId'],
        where: { runId: { in: ids }, type: 'llm_response' },
      })
    ),
    runUnscoped(
      'run history sweep asks which runs are in the usage rollup',
      ['AgentTraceDailyUsage'],
      () => prisma.agentTraceDailyUsage.groupBy({ by: ['runId'], where: { runId: { in: ids } } })
    ),
  ]);

  const skip = new Set<string>();
  const keptIds = new Set<string>();
  const keep = (id: string | undefined, reason: keyof PruneRunHistoryKept) => {
    if (id && !skip.has(id)) {
      skip.add(id);
      keptIds.add(id);
      if (!previousKept.has(id)) {
        kept[reason] += 1;
      }
    }
  };
  for (const w of ledger) {
    keep(byWorkflowId.get(w.temporalWorkflowId), 'held');
  }
  for (const c of callbacks) {
    keep(c.workflowRunId, 'pendingCallback');
  }
  const rolledIds = new Set(rolled.map((r) => r.runId));
  for (const t of traced) {
    if (t.runId && !rolledIds.has(t.runId)) {
      keep(t.runId, 'unrolledSpend');
    }
  }

  // The object goes before the row: the cascade removes only the row, so an object left behind
  // would have nothing pointing at it. A run whose object cannot be deleted is tried next sweep.
  const eligible = ids.filter((id) => !skip.has(id));
  if (eligible.length > 0) {
    const artifacts = await prisma.workflowArtifact.findMany({
      select: { id: true, runId: true },
      where: { backend: 's3', runId: { in: eligible } },
    });
    for (const artifact of artifacts) {
      if (artifact.runId && skip.has(artifact.runId)) {
        continue;
      }
      if (expired()) {
        // Out of time: a run whose objects were not all deleted must not go, or they would be
        // orphaned. It is not a failure; the next sweep reaches it.
        if (artifact.runId) {
          skip.add(artifact.runId);
        }
        continue;
      }
      heartbeat(`run history artifact ${artifact.id}`);
      try {
        await deleteArtifact(artifact.id);
      } catch (err) {
        keep(artifact.runId ?? undefined, 'storageFailed');
        logWarn('run history sweep could not delete an artifact object; its run is kept', {
          artifactId: artifact.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const deletable = ids.filter((id) => !skip.has(id));
  if (deletable.length === 0) {
    return { deleted: 0, keptIds };
  }
  heartbeat('run history delete');
  // Re-states the finished and not-held conditions: a legal hold placed since the read still wins.
  const { count } = await prisma.workflowRun.deleteMany({
    where: { ...where, id: { in: deletable } },
  });
  return { deleted: count, keptIds };
}
