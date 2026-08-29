import { Prisma } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import { notifySlackHumanStep } from '../lib/slackNotify.js';

/**
 * Upsert the workflow's current status. Workflows that lack a pre-existing
 * ActiveWorkflow row (e.g. epic-orchestrator workflows, or engineering workflows
 * spawned as children by an epic) self-register on their first state call.
 *
 * The gateway-created row, when present, already has repoId/workRequestId/etc.
 * — those columns are nullable so the create branch leaves them null and they
 * stay null forever for self-registered rows. That's intentional: the epic row
 * doesn't belong to a single repo, and child rows could backfill repoId later
 * via a separate code path if needed.
 */
export async function updateDomainState(temporalWorkflowId: string, status: string): Promise<void> {
  await prisma.activeWorkflow.upsert({
    create: { currentStatus: status, temporalWorkflowId },
    update: { currentStatus: status },
    where: { temporalWorkflowId },
  });
}

export async function resolveHumanStep(input: {
  runId: string;
  nodeId: string;
  status: 'TIMED_OUT';
}): Promise<void> {
  await prisma.workflowHumanStep.updateMany({
    data: { resolvedAt: new Date(), status: input.status },
    where: { nodeId: input.nodeId, runId: input.runId, status: 'PENDING' },
  });
}

/**
 * Mark ALL pending human steps for a run as CANCELLED.
 * Called during workflow finalization so that steps left waiting by a
 * cancellation, hard failure, or other abnormal exit don't linger in the inbox.
 */
export async function cancelPendingHumanSteps(runId: string): Promise<void> {
  await prisma.workflowHumanStep.updateMany({
    data: { resolvedAt: new Date(), status: 'CANCELLED' },
    where: { runId, status: 'PENDING' },
  });
}

export interface CreateHumanStepInput {
  runId: string;
  nodeId: string;
  signalName: string;
  kind: 'APPROVAL' | 'DECISION' | 'INPUT' | 'REVIEW';
  title: string;
  description?: string;
  context?: unknown;
  options?: Array<{ label: string; value: string }>;
  fields?: Array<{
    key: string;
    label: string;
    type: string;
    required?: boolean;
    options?: string[];
  }>;
  /** Raw timeout duration string from the node spec (e.g. "24h", "30m"). */
  timeout?: string;
  /** Number of distinct approvals required to resolve this step. */
  requiredApprovers?: number;
}

/** Parse simple duration strings like "30m", "4h", "7d" into milliseconds. */
function parseDurationMs(duration: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(duration.trim());
  if (!match) {
    return 0;
  }
  const value = parseFloat(match[1]);
  const multipliers: Record<string, number> = {
    d: 86_400_000,
    h: 3_600_000,
    m: 60_000,
    ms: 1,
    s: 1_000,
  };
  return value * (multipliers[match[2]] ?? 0);
}

/**
 * Create a WorkflowHumanStep record in the DB and send a best-effort Slack
 * notification via {@link notifySlackHumanStep} (origin thread preferred,
 * team channel fallback, inbox link). Called by the Temporal-backed dispatcher
 * when a HITL node is reached.
 */
export async function createHumanStep(input: CreateHumanStepInput): Promise<void> {
  // Idempotency guard: the DB has a partial unique index on (run_id, node_id) WHERE
  // status = 'PENDING'. On Temporal retry, the INSERT will throw P2002 (unique constraint
  // violation); we swallow that and fall through to the Slack block so the notification
  // is still sent even when the DB write was already done by an earlier attempt.
  // Note: we intentionally do NOT return early on P2002 — the Slack notification must
  // reach the user even when the DB create was skipped.
  let stepId: string | undefined;
  try {
    const timeoutAt =
      input.timeout && parseDurationMs(input.timeout) > 0
        ? new Date(Date.now() + parseDurationMs(input.timeout))
        : undefined;
    const created = await prisma.workflowHumanStep.create({
      data: {
        context: input.context !== undefined ? (input.context as Prisma.InputJsonValue) : undefined,
        description: input.description,
        fields: input.fields !== undefined ? (input.fields as Prisma.InputJsonValue) : undefined,
        kind: input.kind,
        nodeId: input.nodeId,
        options: input.options !== undefined ? (input.options as Prisma.InputJsonValue) : undefined,
        requiredApprovers: input.requiredApprovers,
        runId: input.runId,
        signalName: input.signalName,
        timeoutAt,
        title: input.title,
      },
    });
    stepId = created.id;
  } catch (err) {
    // Unique constraint violation — another Temporal attempt already created the PENDING row.
    // Fall through to attempt the Slack notification.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
      throw err;
    }
    // Recover the existing row's id so the Slack message still carries
    // resolve buttons. Best-effort — a miss just degrades to link-only.
    const existing = await prisma.workflowHumanStep.findFirst({
      select: { id: true },
      where: { nodeId: input.nodeId, runId: input.runId, status: 'PENDING' },
    });
    stepId = existing?.id;
  }

  // Best-effort Slack notification. notifySlackHumanStep owns the channel
  // resolution (origin thread → team channel), the token check, the timeout,
  // and the catch — a Slack failure must not fail the activity. `stepId` and
  // `options` let it attach Block Kit resolve buttons (approval/decision).
  await notifySlackHumanStep({
    description: input.description,
    kind: input.kind,
    options: input.options,
    runId: input.runId,
    stepId,
    title: input.title,
  });
}
