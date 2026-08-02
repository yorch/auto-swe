import type { FastifyInstance } from 'fastify';
import { getErrorName } from '../plugins/auth.js';
import { isUniqueConstraintError } from './prismaErrors.js';

/**
 * Launch a tracked run: write its ledger rows, then start the Temporal
 * workflow, compensating if the start fails.
 *
 * ## Why the ledger comes first
 *
 * These handlers used to start Temporal and only then write `RunInput` /
 * `ActiveWorkflow`, on the reasoning that Temporal's
 * `WorkflowExecutionAlreadyStartedError` was the idempotency gate and that
 * orphaned DB rows would block future retries. Both halves worked out badly:
 *
 * - **The failure modes are not symmetric.** If the DB write failed, a workflow
 *   was already running — burning budget, pushing branches, opening PRs — with
 *   no row to attribute it to. `recordLlmUsage` and `finalizeWorkflowRun` then
 *   operated on rows that did not exist. The reverse orphan (rows, no workflow)
 *   is inert, visible in the dashboard, and operator-recoverable.
 * - **It wedged the ticket anyway.** `allocateWorkflowId` derives its `-rN`
 *   suffix from the `ActiveWorkflow` rows for a ticket. With no row written, a
 *   resubmission re-allocated the *base* ID, which Temporal then rejected as
 *   already-started — so the ticket stayed unsubmittable until the orphaned
 *   execution aged out, with nothing in the DB to explain why.
 *
 * Writing the rows first also makes dedup **atomic**: the unique index on
 * `ActiveWorkflow.temporalWorkflowId` decides the winner of two concurrent
 * submissions, where the previous read-then-start sequence had a TOCTOU gap.
 * It is durable too — a DB row outlives Temporal's execution-retention window,
 * so a deterministic ID (`jira-<ticket>`) keeps deduping after Temporal has
 * forgotten the closed execution.
 *
 * ## Compensation
 *
 * If the start fails we delete the rows we just wrote, so a transient Temporal
 * outage doesn't permanently block the ticket. Compensation is best-effort: if
 * it also fails, the rows remain as a visible non-terminal run — the inert,
 * recoverable failure mode rather than the invisible one.
 */

/**
 * Rows to write before the workflow starts. `runInput` is omitted on re-runs;
 * `activeWorkflow` is omitted by launches that do not keep a spend ledger.
 *
 * **Omitting `activeWorkflow` gives up atomic dedup**, because the unique index
 * on `ActiveWorkflow.temporalWorkflowId` is what decides the winner of two
 * concurrent submissions. Such a launch still gets ledger-before-start ordering
 * and compensation; its only duplicate protection is Temporal's own
 * `WorkflowExecutionAlreadyStartedError`, which is a TOCTOU-prone gate and does
 * nothing at all when the workflow ID is random. Prefer passing the row.
 */
export type WorkflowLedgerRows = {
  /** `RunInput` row, when this launch creates one (skipped when re-running). */
  runInput?: Record<string, unknown>;
} & (
  | {
      /** `ActiveWorkflow` row. Must carry `temporalWorkflowId`. */
      activeWorkflow: Record<string, unknown> & { temporalWorkflowId: string };
      temporalWorkflowId?: never;
    }
  | {
      /**
       * No `ActiveWorkflow` row — PRD runs track their spend through
       * `AgentTrace` instead (`finalizeWorkflowRun` sums the traces when the
       * ledger join is empty). The ID is still needed for compensation logging.
       */
      activeWorkflow?: undefined;
      temporalWorkflowId: string;
    }
);

export type LaunchWorkflowResult =
  | {
      ok: true;
      /** `null` when the launch wrote no `ActiveWorkflow` row. */
      activeWorkflowId: string | null;
    }
  /**
   * Another run already owns this workflow ID — either the ledger insert lost
   * the unique-index race or Temporal reported the execution already started.
   * Callers map this to their own conflict response (409 / `duplicate: true`).
   */
  | { ok: false; reason: 'DUPLICATE' };

export async function launchTrackedWorkflow(
  prisma: FastifyInstance['prisma'],
  rows: WorkflowLedgerRows,
  start: () => Promise<unknown>,
  opts?: { log?: { error: (obj: unknown, msg?: string) => void } }
): Promise<LaunchWorkflowResult> {
  const { runInput } = rows;
  // Read `rows.activeWorkflow` rather than a destructured local: destructuring
  // discards the union narrowing that proves one of the two carries the ID.
  const activeWorkflow = rows.activeWorkflow;
  const temporalWorkflowId: string = rows.activeWorkflow
    ? rows.activeWorkflow.temporalWorkflowId
    : rows.temporalWorkflowId;

  // 1. Ledger first, atomically. A P2002 here is the dedup gate firing.
  let activeWorkflowId: string | null;
  try {
    const writes = [
      ...(runInput
        ? [prisma.runInput.create({ data: runInput as never })]
        : ([] as ReturnType<typeof prisma.runInput.create>[])),
      ...(activeWorkflow
        ? [prisma.activeWorkflow.create({ data: activeWorkflow as never })]
        : ([] as ReturnType<typeof prisma.activeWorkflow.create>[])),
    ];
    const results = (await prisma.$transaction(writes)) as Array<{ id: string }>;
    activeWorkflowId = activeWorkflow ? results[results.length - 1].id : null;
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { ok: false, reason: 'DUPLICATE' };
    }
    throw err;
  }

  // 2. Start the workflow; undo the ledger write if it never got going.
  try {
    await start();
  } catch (err) {
    await compensate(
      prisma,
      { activeWorkflowId, runInputId: runInput?.id as string | undefined },
      {
        log: opts?.log,
        temporalWorkflowId,
      }
    );
    if (getErrorName(err) === 'WorkflowExecutionAlreadyStartedError') {
      return { ok: false, reason: 'DUPLICATE' };
    }
    throw err;
  }

  return { activeWorkflowId, ok: true };
}

/**
 * Best-effort removal of the rows written for a workflow that never started.
 * Never throws: leaving the rows behind is the recoverable failure mode, and
 * the caller still needs to surface the original start error.
 */
async function compensate(
  prisma: FastifyInstance['prisma'],
  ids: { activeWorkflowId: string | null; runInputId?: string },
  ctx: { temporalWorkflowId: string; log?: { error: (obj: unknown, msg?: string) => void } }
): Promise<void> {
  // Each delete is independent: a failure cleaning up one row must not strand
  // the other. (Deleting the ActiveWorkflow first also keeps the FK happy.)
  const deletes: Array<[string, () => Promise<unknown>]> = [
    ...(ids.activeWorkflowId
      ? ([
          [
            'activeWorkflow',
            () => prisma.activeWorkflow.delete({ where: { id: ids.activeWorkflowId as string } }),
          ],
        ] as Array<[string, () => Promise<unknown>]>)
      : []),
    ...(ids.runInputId
      ? ([
          ['runInput', () => prisma.runInput.delete({ where: { id: ids.runInputId as string } })],
        ] as Array<[string, () => Promise<unknown>]>)
      : []),
  ];

  for (const [row, run] of deletes) {
    try {
      await run();
    } catch (cleanupErr) {
      ctx.log?.error(
        { err: cleanupErr, row, temporalWorkflowId: ctx.temporalWorkflowId },
        'workflow start failed and ledger cleanup also failed — row left for manual recovery'
      );
    }
  }
}
