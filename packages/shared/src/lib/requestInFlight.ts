import type { PrismaClient } from '../index.js';
import { ACTIVE_WORKFLOW_TERMINAL_STATUSES } from '../types/api.js';
import {
  type ClosedLedgerStatus,
  RECONCILE_GRACE_MS,
  RECONCILE_LOOKUP_TIMEOUT_MS,
} from './agentRunAdmission.js';

/**
 * What Temporal says about a workflow: the ledger status its row closes with
 * when the execution is finished or does not exist, null while it runs. It must
 * THROW when Temporal cannot be asked.
 */
export type SettledLookup = (workflowId: string) => Promise<ClosedLedgerStatus | null>;

/** A row that blocks: `unconfirmed` when Temporal could not be asked. */
export interface InFlight {
  temporalWorkflowId: string;
  unconfirmed: boolean;
}

type Verdict =
  | { kind: 'live' }
  | { kind: 'unconfirmed' }
  | { kind: 'gone'; status: ClosedLedgerStatus };

/** Is this ledger row's execution still there? Trusts a row written within the grace window. */
async function judge(
  updatedAt: Date,
  now: number,
  id: string,
  settled: SettledLookup
): Promise<Verdict> {
  if (now - updatedAt.getTime() < RECONCILE_GRACE_MS) {
    return { kind: 'live' };
  }
  try {
    const status = await new Promise<ClosedLedgerStatus | null>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Temporal lookup timed out')),
        RECONCILE_LOOKUP_TIMEOUT_MS
      );
      settled(id).then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e);
        }
      );
    });
    return status ? { kind: 'gone', status } : { kind: 'live' };
  } catch {
    return { kind: 'unconfirmed' };
  }
}

/**
 * Closes ledger rows with the status Temporal gave them. Conditional on the row
 * still being non-terminal, so it cannot overwrite what a finalizer wrote since.
 * Cleanup only: the caller's answer is right either way and the next ask retries.
 */
async function closeRows(
  db: PrismaClient,
  closes: { id: string; status: ClosedLedgerStatus }[]
): Promise<void> {
  for (const status of new Set(closes.map((c) => c.status))) {
    await db.activeWorkflow
      .updateMany({
        data: { currentStatus: status },
        where: {
          currentStatus: { notIn: [...ACTIVE_WORKFLOW_TERMINAL_STATUSES] },
          temporalWorkflowId: { in: closes.filter((c) => c.status === status).map((c) => c.id) },
        },
      })
      .catch(() => undefined);
  }
}

/**
 * Confirm one ledger row that an allocator says is in flight: null when its
 * execution is over (the row is closed), else the blocking row. A row that
 * cannot be found is kept as blocking.
 */
export async function confirmInFlight(
  db: PrismaClient,
  workflowId: string,
  opts: { settled: SettledLookup; now?: Date }
): Promise<InFlight | null> {
  const row = await db.activeWorkflow.findUnique({
    select: { updatedAt: true },
    where: { temporalWorkflowId: workflowId },
  });
  if (!row) {
    return { temporalWorkflowId: workflowId, unconfirmed: false };
  }
  const now = (opts.now ?? new Date()).getTime();
  const verdict = await judge(row.updatedAt, now, workflowId, opts.settled);
  if (verdict.kind === 'gone') {
    await closeRows(db, [{ id: workflowId, status: verdict.status }]);
    return null;
  }
  return { temporalWorkflowId: workflowId, unconfirmed: verdict.kind === 'unconfirmed' };
}

/**
 * The execution of a work request that is still running, or null.
 *
 * Every run of a request (an `eng-…` run or re-run, a scheduled fire) has its
 * own `ActiveWorkflow` row carrying the request's id, and the row stays
 * non-terminal until the run ends. `allocateWorkflowId` only sees one ID
 * family, so a re-run of a scheduled request would not see a fire `sched-<id>-<ts>`,
 * and a fire would not see a re-run: both would push the request's one branch
 * and the later one would re-link the other's pull request.
 *
 * A ledger row is a claim, and some are never closed: a launch that failed
 * between the row and the workflow, a workflow terminated before its first
 * activity. The run reaper works from run rows, which these have none of, so
 * each candidate is confirmed with Temporal (`settled`, built on the check
 * agent-run admission uses). A row whose workflow is finished or absent is closed
 * with the status Temporal gives it (`closedLedgerStatusFor`) and does not block. A row touched within `RECONCILE_GRACE_MS` is trusted
 * without asking, because a launch writes its row before it starts the workflow.
 * When Temporal cannot be asked the row blocks and is returned `unconfirmed`:
 * overlap fails closed.
 *
 * The schedule's anchor row (`SCHEDULED`, `sched-<id>`) is not an execution and
 * is never returned. `ignoreFires` leaves out every `sched-` row, for the fire's
 * own question: "is something other than a fire running?" (the Schedule's SKIP
 * overlap policy already keeps fires from overlapping each other).
 */
export async function liveInFlightExecution(
  db: PrismaClient,
  workRequestId: string,
  opts: { ignoreFires?: boolean; settled: SettledLookup; now?: Date }
): Promise<InFlight | null> {
  const rows = await db.activeWorkflow.findMany({
    orderBy: { updatedAt: 'asc' },
    select: { temporalWorkflowId: true, updatedAt: true },
    where: {
      currentStatus: { notIn: [...ACTIVE_WORKFLOW_TERMINAL_STATUSES, 'SCHEDULED'] },
      workRequestId,
      ...(opts.ignoreFires ? { NOT: { temporalWorkflowId: { startsWith: 'sched-' } } } : {}),
    },
  });
  const now = (opts.now ?? new Date()).getTime();
  const closes: { id: string; status: ClosedLedgerStatus }[] = [];
  let blocking: InFlight | null = null;
  for (const row of rows) {
    const id = row.temporalWorkflowId;
    const verdict = await judge(row.updatedAt, now, id, opts.settled);
    if (verdict.kind === 'gone') {
      closes.push({ id, status: verdict.status });
      continue;
    }
    blocking = { temporalWorkflowId: id, unconfirmed: verdict.kind === 'unconfirmed' };
    break;
  }
  await closeRows(db, closes);
  return blocking;
}
