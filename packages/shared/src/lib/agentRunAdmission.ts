import { ACTIVE_WORKFLOW_TERMINAL_STATUSES } from '../types/api.js';

/**
 * Concurrency admission for agent runs.
 *
 * An agent run holds a worker activity slot and a workspace container for its
 * whole wall clock, and the worker has one small slot pool shared with every
 * engineering run, eval and channel task. A few launches can therefore stall
 * the platform, so the number in flight is capped globally and per team.
 *
 * The gateway checks this for a friendly 429; the WORKER checks it again, and
 * the worker is the authority: other launch paths reach the same template, and
 * two simultaneous launches both pass a gateway-side count. Admission is
 * therefore a deterministic RANK, not a count-then-start race: of the runs in
 * flight, the oldest `limit` are admitted and a newer one is refused. Two
 * racing launches at limit 1 cannot both proceed, and cannot both be refused.
 */

export interface AgentRunSlot {
  /** `ActiveWorkflow.temporalWorkflowId` */
  workflowId: string;
  /** Owning team of the repository; null when unknown. */
  teamId: string | null;
  /** `RunInput.createdAt`, the launch order. */
  launchedAt: Date;
}

export type AdmissionDecision =
  | { admitted: true }
  | { admitted: false; reason: 'disabled' | 'global_limit' | 'team_limit' | 'unknown_run' };

export interface AdmissionLimits {
  /** `workspace.agentRunMaxConcurrentGlobal`; 0 disables agent runs. */
  global: number;
  /** `workspace.agentRunMaxConcurrentPerTeam` for the run's team; 0 disables. */
  perTeam: number;
}

const order = (a: AgentRunSlot, b: AgentRunSlot): number =>
  a.launchedAt.getTime() - b.launchedAt.getTime() || a.workflowId.localeCompare(b.workflowId);

/**
 * `inFlight` is every non-terminal agent run, INCLUDING `self`. Worker side:
 * the run asks whether it is among the oldest `limit` in flight.
 */
export function decideAdmission(
  inFlight: readonly AgentRunSlot[],
  self: { workflowId: string; teamId: string | null },
  limits: AdmissionLimits
): AdmissionDecision {
  if (limits.global <= 0 || limits.perTeam <= 0) {
    return { admitted: false, reason: 'disabled' };
  }
  const sorted = [...inFlight].sort(order);
  const globalRank = sorted.findIndex((r) => r.workflowId === self.workflowId);
  if (globalRank === -1) {
    // Fail closed: a run that cannot find itself cannot show it was admitted.
    return { admitted: false, reason: 'unknown_run' };
  }
  if (globalRank >= limits.global) {
    return { admitted: false, reason: 'global_limit' };
  }
  const sameTeam = sorted.filter((r) => r.teamId === self.teamId);
  const teamRank = sameTeam.findIndex((r) => r.workflowId === self.workflowId);
  if (teamRank === -1) {
    // The run is in flight, but not under the team it claims: fail closed here
    // too, rather than let -1 slip under the per-team limit.
    return { admitted: false, reason: 'unknown_run' };
  }
  if (teamRank >= limits.perTeam) {
    return { admitted: false, reason: 'team_limit' };
  }
  return { admitted: true };
}

/** Gateway-side: would one more run for `teamId` fit? */
export function wouldAdmitNewRun(
  inFlight: readonly AgentRunSlot[],
  teamId: string | null,
  limits: AdmissionLimits
): AdmissionDecision {
  if (limits.global <= 0 || limits.perTeam <= 0) {
    return { admitted: false, reason: 'disabled' };
  }
  if (inFlight.length >= limits.global) {
    return { admitted: false, reason: 'global_limit' };
  }
  if (inFlight.filter((r) => r.teamId === teamId).length >= limits.perTeam) {
    return { admitted: false, reason: 'team_limit' };
  }
  return { admitted: true };
}

/** The slice of a Prisma client the loader needs, so the gateway and worker share it. */
interface ActiveWorkflowReader {
  activeWorkflow: {
    findMany: (args: {
      select: {
        currentStatus: true;
        temporalWorkflowId: true;
        repository: { select: { teamId: true } };
        workRequest: { select: { createdAt: true } };
      };
      where: { currentStatus: { notIn: string[] }; workRequest: { templateId: string } };
    }) => Promise<
      Array<{
        currentStatus: string;
        temporalWorkflowId: string;
        repository: { teamId: string } | null;
        workRequest: { createdAt: Date } | null;
      }>
    >;
  };
}

/** Every non-terminal run of the system template, as admission slots. */
export async function loadAgentRunSlots(
  db: ActiveWorkflowReader,
  systemTemplateId: string
): Promise<AgentRunSlot[]> {
  const rows = await db.activeWorkflow.findMany({
    select: {
      currentStatus: true,
      repository: { select: { teamId: true } },
      temporalWorkflowId: true,
      workRequest: { select: { createdAt: true } },
    },
    // Filtered in the database: the template's history grows without bound,
    // and only what is still running can hold a slot.
    where: {
      currentStatus: { notIn: [...ACTIVE_WORKFLOW_TERMINAL_STATUSES] },
      workRequest: { templateId: systemTemplateId },
    },
  });
  return rows.map((r) => ({
    launchedAt: r.workRequest?.createdAt ?? new Date(0),
    teamId: r.repository?.teamId ?? null,
    workflowId: r.temporalWorkflowId,
  }));
}

/**
 * A row's launch is given this long to reach Temporal before "no such workflow"
 * can mean anything. The gateway writes the ledger rows first and starts the
 * workflow second, so a brand-new row legitimately has no execution yet.
 */
export const RECONCILE_GRACE_MS = 5 * 60_000;

/** Most Temporal lookups one admission call may make. */
export const RECONCILE_MAX_CHECKS = 8;

/** One lookup is abandoned after this long, and its row keeps counting. */
export const RECONCILE_LOOKUP_TIMEOUT_MS = 3_000;

/**
 * A row positively confirmed running is not asked about again for this long.
 * Without it the oldest rows (the long-running live ones) are re-described by
 * every admission and the stale rows behind them are never reached.
 */
export const RECONCILE_RECHECK_MS = 60_000;

const confirmedRunning = new Map<string, number>();

/** Test seam: forget which rows were recently confirmed running. */
export function __resetReconcileCacheForTests(): void {
  confirmedRunning.clear();
}

/** Temporal execution states from which a workflow never runs again. */
const FINISHED_WORKFLOW_STATUSES: ReadonlySet<string> = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TERMINATED',
  'TIMED_OUT',
]);

/**
 * The single definition of "this workflow is gone" for admission, shared by the
 * gateway and the worker. Only a definitively finished status counts;
 * `CONTINUED_AS_NEW`, `UNSPECIFIED`, an absent status and any status a future
 * Temporal adds all keep the slot. (A workflow that does not exist at all is
 * the caller's `WorkflowNotFoundError`, which each side maps to gone itself.)
 */
export function isWorkflowStatusFinished(statusName: string | undefined): boolean {
  return statusName !== undefined && FINISHED_WORKFLOW_STATUSES.has(statusName);
}

/** The terminal `ActiveWorkflow` statuses a finished execution can leave behind. */
export type ClosedLedgerStatus = 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED';

/**
 * The ledger status a Temporal execution state closes a row with, or null while
 * it has not finished (`isWorkflowStatusFinished`). The same mapping the run
 * reaper applies to a run (`reapedStatusFor`, where COMPLETED reads SUCCESS):
 * a stop on purpose is CANCELLED, not a failure; anything else that finished
 * without an outcome of its own is FAILED.
 */
export function closedLedgerStatusFor(statusName: string | undefined): ClosedLedgerStatus | null {
  if (!isWorkflowStatusFinished(statusName)) {
    return null;
  }
  switch (statusName) {
    case 'COMPLETED':
      return 'COMPLETED';
    case 'TIMED_OUT':
      return 'TIMED_OUT';
    case 'CANCELLED':
    case 'TERMINATED':
      return 'CANCELLED';
    default:
      return 'FAILED';
  }
}

export interface ReconcileOptions {
  /**
   * Whether the run's workflow is still executing in Temporal: `true` while it
   * runs, `false` once it is terminal or does not exist. It must THROW when
   * Temporal cannot be asked — an unanswered question is not "closed".
   */
  isRunning: (workflowId: string) => Promise<boolean>;
  /** Marks these ledger rows terminal so they stop being loaded as in flight. */
  close: (workflowIds: string[]) => Promise<void>;
  /** The calling run, which is running by definition and is never looked up. */
  self?: string;
  now?: Date;
  graceMs?: number;
  maxChecks?: number;
  lookupTimeoutMs?: number;
  recheckMs?: number;
  /** A lookup that could not be answered; the row keeps counting. */
  onUnreachable?: (workflowId: string, err: unknown) => void;
  /** Rows whose workflow is gone; they have been closed. */
  onClosed?: (workflowIds: string[]) => void;
}

/**
 * Drops from `slots` every run whose workflow Temporal says is no longer
 * running, and closes its ledger row.
 *
 * A workflow terminated, or timed out, outside its own finalizer leaves a
 * non-terminal `ActiveWorkflow` row that would otherwise hold a concurrency slot
 * indefinitely. The ledger status is a claim; Temporal is the authority on
 * whether the run exists.
 *
 * Lazy and bounded: it runs only inside an admission call, looks at no more than
 * `maxChecks` rows (oldest launch first, since those are the likeliest to be
 * stale), skips `self` and anything launched within the grace window, and adds
 * nothing to the schema.
 *
 * Fail-safe: a lookup that throws leaves its row counted. Admission may then be
 * stricter than the truth, never looser.
 *
 * The rank-based decision stays race-free because closing is idempotent and
 * driven by one shared truth: two admissions reconciling concurrently drop the
 * same rows. If a Temporal hiccup makes their views differ, the view that kept
 * a row sees a larger queue, so the worst case is a refusal both would not have
 * issued, never two admissions at a limit of one.
 */
export async function reconcileAgentRunSlots(
  slots: readonly AgentRunSlot[],
  opts: ReconcileOptions
): Promise<AgentRunSlot[]> {
  const now = (opts.now ?? new Date()).getTime();
  const graceMs = opts.graceMs ?? RECONCILE_GRACE_MS;
  const timeoutMs = opts.lookupTimeoutMs ?? RECONCILE_LOOKUP_TIMEOUT_MS;
  const recheckMs = opts.recheckMs ?? RECONCILE_RECHECK_MS;
  const live = new Set(slots.map((s) => s.workflowId));
  for (const [id, until] of confirmedRunning) {
    if (until <= now || !live.has(id)) {
      confirmedRunning.delete(id);
    }
  }
  const candidates = [...slots]
    .filter(
      (s) =>
        s.workflowId !== opts.self &&
        now - s.launchedAt.getTime() >= graceMs &&
        !confirmedRunning.has(s.workflowId)
    )
    .sort(order)
    .slice(0, Math.max(0, opts.maxChecks ?? RECONCILE_MAX_CHECKS));
  if (candidates.length === 0) {
    return [...slots];
  }

  const withDeadline = (workflowId: string): Promise<boolean> =>
    new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Temporal lookup timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
      opts.isRunning(workflowId).then(
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
  const answers = await Promise.allSettled(candidates.map((c) => withDeadline(c.workflowId)));
  const gone = new Set<string>();
  answers.forEach((answer, i) => {
    const id = (candidates[i] as AgentRunSlot).workflowId;
    if (answer.status === 'rejected') {
      opts.onUnreachable?.(id, answer.reason);
    } else if (answer.value === false) {
      gone.add(id);
    } else {
      confirmedRunning.set(id, now + recheckMs);
    }
  });
  if (gone.size === 0) {
    return [...slots];
  }

  try {
    await opts.close([...gone]);
    opts.onClosed?.([...gone]);
  } catch (err) {
    // The decision below is still right (Temporal says these are not running);
    // only the cleanup failed, and the next admission will try again.
    for (const id of gone) {
      opts.onUnreachable?.(id, err);
    }
  }
  return slots.filter((s) => !gone.has(s.workflowId));
}

/** The slice of a Prisma client that closes ledger rows. */
interface ActiveWorkflowCloser {
  activeWorkflow: {
    updateMany: (args: {
      data: { currentStatus: 'FAILED' };
      where: { currentStatus: { notIn: string[] }; temporalWorkflowId: { in: string[] } };
    }) => Promise<unknown>;
  };
}

/**
 * Marks ledger rows terminal. `FAILED` is the honest default: the row was
 * non-terminal while its workflow no longer exists, so it never finalised.
 * Conditional on still being non-terminal, so it cannot overwrite a status a
 * finalizer wrote in the meantime.
 */
export function closeAgentRunLedgerRows(
  db: ActiveWorkflowCloser
): (workflowIds: string[]) => Promise<void> {
  return async (workflowIds) => {
    await db.activeWorkflow.updateMany({
      data: { currentStatus: 'FAILED' },
      where: {
        currentStatus: { notIn: [...ACTIVE_WORKFLOW_TERMINAL_STATUSES] },
        temporalWorkflowId: { in: workflowIds },
      },
    });
  };
}
