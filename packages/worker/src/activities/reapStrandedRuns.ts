/**
 * The run reaper: finalizes `WorkflowRun` rows whose Temporal execution is over
 * but which nothing ever finalized.
 *
 * A run is finalized by its own workflow's last step. A workflow terminated or
 * timed out outside the worker never reaches that step; a run cancelled between
 * its row being created and Temporal recording that activity exits before it;
 * and a dashboard cancel that finds the execution already gone deliberately
 * leaves the row for this sweep to bill. Left alone, each keeps its accrued
 * cost in the organization cap's in-flight figure for ever.
 *
 * The write is the workflow's own finalization core (`finalizeRun`), so billing
 * is exactly once however this races a late finalize: the guarded `endedAt`
 * write decides, and the loser does nothing.
 */
import { prisma } from '@auto-swe/shared/db';
import { isWorkflowStatusFinished } from '@auto-swe/shared/lib/agentRunAdmission';
import { WorkflowNotFoundError } from '@temporalio/client';
import { logWarn } from '../lib/activityLog.js';
import { getTemporalClient } from '../lib/temporalClient.js';
import { finalizeChannelRun } from './channelRun.js';
import { finalizeRun } from './templates.js';

/** A run younger than this is never looked up: its workflow is still starting up. */
export const REAPER_GRACE_MS = 10 * 60 * 1000;
/** Most runs asked about per sweep: never-checked first, then least recently checked. */
export const REAPER_MAX_CHECKS = 200;
const LOOKUP_TIMEOUT_MS = 5_000;
const LOOKUP_CONCURRENCY = 10;

export type ReapedStatus = 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED';

/**
 * What a finished Temporal execution means for the run. An execution that no
 * longer exists is `FAILED`: it never reported an outcome. A run the dashboard
 * already cancelled keeps `CANCELLED` whatever is passed here (`endWorkflowRun`).
 */
export function reapedStatusFor(temporalStatus: string | undefined): ReapedStatus {
  switch (temporalStatus) {
    case 'COMPLETED':
      return 'SUCCESS';
    case 'TIMED_OUT':
      return 'TIMED_OUT';
    case 'CANCELLED':
    case 'TERMINATED':
      return 'CANCELLED'; // stopped on purpose, not a failure of the run
    default:
      return 'FAILED';
  }
}

/** An execution that closed longer ago than this ended too long ago to tell anyone about. */
export const NOTIFY_WINDOW_MS = 60 * 60 * 1000;

interface Ended {
  status: ReapedStatus;
  /** False for a vanished execution or one closed before the notify window. */
  notify: boolean;
}

/** How the run ended, or `null` while its execution still runs. Throws when Temporal cannot say. */
async function endedStatusOf(workflowId: string, now: Date): Promise<Ended | null> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Temporal lookup timed out after ${LOOKUP_TIMEOUT_MS}ms`)),
      LOOKUP_TIMEOUT_MS
    );
  });
  try {
    const { closeTime, status } = await Promise.race([
      getTemporalClient().workflow.getHandle(workflowId).describe(),
      deadline,
    ]);
    if (!isWorkflowStatusFinished(status.name)) {
      return null;
    }
    const closedAt = closeTime?.getTime();
    return {
      notify: closedAt !== undefined && now.getTime() - closedAt <= NOTIFY_WINDOW_MS,
      status: reapedStatusFor(status.name),
    };
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) {
      return { notify: false, status: 'FAILED' };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface ReapStrandedRunsResult {
  checked: number;
  reaped: number;
  /** Runs left alone this sweep: Temporal could not be asked, or finalizing failed. */
  unreachable: number;
}

export async function reapStrandedRuns(now = new Date()): Promise<ReapStrandedRunsResult> {
  const runs = await prisma.workflowRun.findMany({
    // Never-checked runs first, then the longest since a check: a run confirmed
    // live goes to the back, so a crowd of long-lived live runs cannot hold the
    // batch and keep newer stranded runs from ever being reached.
    orderBy: [{ reapCheckedAt: { nulls: 'first', sort: 'asc' } }, { startedAt: 'asc' }],
    select: { channelId: true, id: true, workflowId: true, workRequestId: true },
    take: REAPER_MAX_CHECKS,
    where: { endedAt: null, startedAt: { lt: new Date(now.getTime() - REAPER_GRACE_MS) } },
  });
  const result: ReapStrandedRunsResult = { checked: runs.length, reaped: 0, unreachable: 0 };
  const rotated: string[] = [];
  for (let i = 0; i < runs.length; i += LOOKUP_CONCURRENCY) {
    await Promise.all(
      runs.slice(i, i + LOOKUP_CONCURRENCY).map(async (run) => {
        // Fail-safe: an unanswered question is not "finished". A live run is
        // never ended, and so never billed, on a Temporal hiccup. A run whose
        // lookup failed is not stamped, so it stays first in line.
        let ended: Ended | null;
        try {
          ended = await endedStatusOf(run.workflowId, now);
        } catch (err) {
          result.unreachable++;
          logWarn('run reaper could not ask Temporal about a run; it is left for the next sweep', {
            err: err instanceof Error ? err.message : String(err),
            workflowId: run.workflowId,
          });
          return;
        }
        if (!ended) {
          rotated.push(run.id);
          return;
        }
        const { notify, status } = ended;
        try {
          if (!notify) {
            logWarn('run reaper ended a run without notifying: its execution closed long ago', {
              workflowId: run.workflowId,
            });
          }
          // A channel turn has no work request and bills its channel, not an
          // org, so it ends through the channel path. A channel task run has a
          // work request and goes through the core like any other run.
          if (run.channelId && !run.workRequestId) {
            await finalizeChannelRun({ source: 'reaper', status, workflowId: run.workflowId });
          } else {
            await finalizeRun(run.id, status, undefined, 'reaper', notify);
          }
          result.reaped++;
        } catch (err) {
          // Stamped like a live run: one that cannot be finalized must not sit
          // first in every sweep and crowd out the rest.
          rotated.push(run.id);
          result.unreachable++;
          logWarn('run reaper could not finalize a run; it is left for the next sweep', {
            err: err instanceof Error ? err.message : String(err),
            workflowId: run.workflowId,
          });
        }
      })
    );
  }
  if (rotated.length > 0) {
    try {
      await prisma.workflowRun.updateMany({
        data: { reapCheckedAt: now },
        where: { endedAt: null, id: { in: rotated } },
      });
    } catch (err) {
      // Only the rotation suffers: these runs are asked about again next sweep.
      logWarn('run reaper could not record which runs it checked', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (runs.length === REAPER_MAX_CHECKS) {
    logWarn('run reaper checked a full batch; the rest are reached by later sweeps in rotation', {
      max: REAPER_MAX_CHECKS,
    });
  }
  return result;
}
