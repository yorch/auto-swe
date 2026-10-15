/**
 * The two guards every step needs when it changes something outside the
 * platform, in one place because they are properties of the *effect* rather
 * than of one step.
 *
 * 1. **Approval.** If the run's latest `publishOutcome` decision required human
 *    approval and none was recorded since, the mutation is refused. Without
 *    this a template could record the decision — putting "approval required" in
 *    the audit log — and then write anyway through a different step, so the log
 *    claimed a gate that never happened. A run that recorded no decision at all
 *    is not gated: the policy exists only where something asked for it.
 *
 * 2. **Idempotency.** External writes are not idempotent by default, and a
 *    Temporal activity retry after a successful write would repeat it.
 *    `workflowOutcomeReference` remembers the result per
 *    `(run, node, connection)` — deliberately not per attempt, because a retry
 *    IS a new attempt, so an attempt-keyed row could never find the row its
 *    predecessor wrote. `attempt` is still stored for audit.
 *
 * Both live here because `writeOutcome`, `runTool` and `mcpCallTool` reach the
 * same external systems. A mutating call left ungoverned only because the author
 * spelled it as a different step is the hole this closes; adding a guard to one
 * of them and not the others is not a defence.
 */

import { prisma } from '@auto-swe/shared/db';
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';

/** What the guards need to know about the current activity invocation. */
export interface MutationScope {
  /** The `WorkflowRun` row's id, or undefined when there is no run (or no workflow). */
  runId?: string;
  /** The Temporal activity attempt, stored on the ledger row for audit. */
  attempt: number;
}

/** Resolve the current run + attempt. Both guards need them; neither is derivable from the other. */
export async function mutationScope(): Promise<MutationScope> {
  const info = Context.current().info;
  const workflowId = info.workflowExecution?.workflowId;
  const run = workflowId
    ? await prisma.workflowRun.findUnique({ select: { id: true }, where: { workflowId } })
    : null;
  return { attempt: info.attempt, runId: run?.id };
}

/**
 * Refuse a mutation while the run's latest `publishOutcome` decision requires
 * approval and none has been recorded since. A template that records the
 * decision but routes straight to a writing step would otherwise write anyway
 * while the audit log says approval was required.
 */
export async function assertApprovalSatisfied(runId: string): Promise<void> {
  const published = await prisma.autonomyDecision.findFirst({
    orderBy: { createdAt: 'desc' },
    where: { event: 'publish', runId },
  });
  const payload = published?.payload as { decision?: string } | null | undefined;
  if (!published || payload?.decision !== 'require_approval') {
    return;
  }
  const approved = await prisma.autonomyDecision.findFirst({
    where: { createdAt: { gte: published.createdAt }, event: 'approve', runId },
  });
  if (!approved) {
    throw ApplicationFailure.nonRetryable(
      `refused: policy '${published.policyName ?? 'unknown'}' requires human approval for '${
        published.riskClass ?? 'this action'
      }' and none was recorded`,
      'APPROVAL_REQUIRED'
    );
  }
}

/** The ledger key for one step's effect on one connection. */
export interface OutcomeKey {
  connectionId: string;
  nodeId: string;
  runId: string;
}

/** The result a previous attempt of this exact step already produced, if any. */
export async function findRecordedOutcome<T>(key: OutcomeKey): Promise<T | undefined> {
  const existing = await prisma.workflowOutcomeReference.findFirst({
    orderBy: { attempt: 'asc' },
    where: { connectionId: key.connectionId, nodeId: key.nodeId, runId: key.runId },
  });
  return existing ? (existing.result as T) : undefined;
}

/** Remember the effect so a retry returns this result instead of repeating it. */
export async function recordOutcome(
  key: OutcomeKey & { attempt: number; result: unknown }
): Promise<void> {
  await prisma.workflowOutcomeReference.create({
    data: {
      attempt: key.attempt,
      connectionId: key.connectionId,
      nodeId: key.nodeId,
      result: key.result as never,
      runId: key.runId,
    },
  });
}

/**
 * Connector tools that only read.
 *
 * `runTool` names its tool as a string, so nothing in the type system says
 * whether it writes. Everything not listed here is treated as a mutation and has
 * to satisfy the same approval gate `writeOutcome` does — a new tool is gated by
 * default rather than by someone remembering to gate it. Reading is not gated: a
 * run whose policy demanded approval for a write has still not asked for one to
 * look a ticket up.
 *
 * Note this is keyed on the tool *name* alone, not on the connection type: the
 * names below are the ones the connector implementations accept as reads, and a
 * placeholder handler that performs no write is still treated as a mutation.
 */
const READ_ONLY_CONNECTOR_TOOLS: ReadonlySet<string> = new Set([
  'fetchIssue',
  'fetchPage',
  'fetchTicket',
]);

/** Whether a tool call may change state outside the platform. */
export function isMutatingToolCall(tool: string): boolean {
  return !READ_ONLY_CONNECTOR_TOOLS.has(tool);
}
