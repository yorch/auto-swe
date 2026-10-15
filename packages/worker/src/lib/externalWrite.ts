/**
 * The two guards every step needs when it changes something outside the
 * platform, in one place because they are properties of the *effect* rather
 * than of one step.
 *
 * 1. **Approval.** If the run's latest decision that *required* human approval has
 *    no approval recorded after it, the mutation is refused. Without this a
 *    template could record the decision — putting "approval required" in the audit
 *    log — and then write anyway through a different step, so the log claimed a
 *    gate that never happened. A run that recorded no such decision is not gated:
 *    the policy exists only where something asked for it.
 *
 * 2. **Idempotency.** External writes are not idempotent by default, and a
 *    Temporal activity retry after a successful write would repeat it.
 *    `workflowOutcomeReference` holds one row per `(run, node, connection)` —
 *    deliberately not per attempt, because a retry IS a new attempt, so an
 *    attempt-keyed row could never find the row its predecessor wrote; `attempt` is
 *    stored for audit. The row is claimed **before** the provider is called and
 *    completed with what it returned, so a retry that finds a completed row returns
 *    that result and one that finds a bare claim refuses (`OUTCOME_AMBIGUOUS`)
 *    instead of acting twice on an effect whose outcome nothing can tell. A
 *    connector that refused before sending releases the claim, so a refused call is
 *    not mistaken for an ambiguous one. What this cannot see is a *new* run for the
 *    same work: a restart is a new workflow id and an empty ledger.
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
 * Refuse a mutation while the run's policy requires approval it has not received.
 *
 * The decision read is the latest publish that **required** approval, not the latest publish. The
 * contract is run-wide (`docs/autonomy-policies.md`): a requirement from any risk class holds
 * *every* mutation until it is satisfied. Reading the latest publish of any kind let a template
 * publish `require_approval`, then publish a class its policy auto-approves, and then write —
 * with the audit log still recording that approval was required.
 */
export async function assertApprovalSatisfied(runId: string): Promise<void> {
  const published = await prisma.autonomyDecision.findFirst({
    orderBy: { createdAt: 'desc' },
    where: {
      event: 'publish',
      // Matched in the query rather than in code so a later, more permissive decision cannot
      // stand in for this one: the filter is the rule.
      payload: { equals: 'require_approval', path: ['decision'] },
      runId,
    },
  });
  if (!published) {
    return;
  }
  // Belt and braces: the query already excludes anything else, so this cannot fire on a real
  // database. It is here because the filter is the rule, and a filter that went wrong — a payload
  // shape that changed under it, a store that answers a narrower query loosely — would otherwise
  // refuse every mutation instead of none.
  const decision = (published.payload as { decision?: string } | null | undefined)?.decision;
  if (decision !== 'require_approval') {
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

/** An error a connector raised before it contacted the provider, so the effect is known not to have
 * happened. Anything else — a transport error, a timeout, a 5xx, an abandoned call, process death —
 * leaves the claim behind, because nothing can tell whether the provider acted. */
export const NOT_SENT_ERROR = 'NOT_SENT';

/** Raise a refusal the ledger can recognise as "nothing was sent". */
export function notSent(message: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message, NOT_SENT_ERROR);
}

export function definitelyNotSent(err: unknown): boolean {
  return err instanceof ApplicationFailure && err.type === NOT_SENT_ERROR;
}

/**
 * The result a previous attempt of this effect produced, if one completed.
 *
 * A claim without a result refuses instead: the provider may have acted, so calling it again is
 * how one effort becomes two. Refusing is the only safe answer a store can give — the alternative
 * is a duplicate external effect nobody can undo.
 */
export async function findRecordedOutcome<T>(key: OutcomeKey): Promise<T | undefined> {
  const existing = await prisma.workflowOutcomeReference.findFirst({
    where: { connectionId: key.connectionId, nodeId: key.nodeId, runId: key.runId },
  });
  if (!existing) {
    return undefined;
  }
  // Anything that is not a completed effect refuses: an unknown state is a state we cannot read,
  // and acting on it is how one effect becomes two.
  if (existing.state !== 'DONE') {
    throw ApplicationFailure.nonRetryable(
      `refused: an earlier attempt of '${key.nodeId}' may already have reached the provider and ` +
        'did not record what it produced, so repeating it could act twice. Resolve it before ' +
        'retrying.',
      'OUTCOME_AMBIGUOUS'
    );
  }
  return existing.result as T;
}

/** Claim the effect before performing it. */
async function claimOutcome(key: OutcomeKey & { attempt: number }): Promise<void> {
  try {
    await prisma.workflowOutcomeReference.create({
      data: {
        attempt: key.attempt,
        connectionId: key.connectionId,
        nodeId: key.nodeId,
        runId: key.runId,
        state: 'PENDING',
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') {
      throw err;
    }
    // Another attempt holds the claim. The caller read the key first, so this is a genuine race and
    // not a completed effect: refuse rather than let both call the provider.
    throw ApplicationFailure.nonRetryable(
      `refused: another attempt of '${key.nodeId}' is performing this effect right now; repeating ` +
        'it could act twice.',
      'OUTCOME_AMBIGUOUS'
    );
  }
}

/** Release a claim whose effect provably never happened, so a retry may try again. */
async function releaseOutcome(key: OutcomeKey): Promise<void> {
  await prisma.workflowOutcomeReference.deleteMany({
    where: {
      connectionId: key.connectionId,
      nodeId: key.nodeId,
      runId: key.runId,
      state: 'PENDING',
    },
  });
}

/**
 * Perform an external effect once per `(run, node, connection)`, as far as a store can tell.
 *
 * The claim is written before the dispatch and completed with its result, which is what makes a
 * retry safe in both directions: it returns what a completed attempt produced, and refuses when an
 * attempt may have reached the provider without recording anything. A connector that refused before
 * sending — `notSent` — releases the claim, so a refused call is not mistaken for an ambiguous one.
 */
export async function performOnce<T>(args: {
  attempt: number;
  dispatch: () => Promise<T>;
  key: OutcomeKey;
}): Promise<T> {
  await claimOutcome({ ...args.key, attempt: args.attempt });
  try {
    const result = await args.dispatch();
    await prisma.workflowOutcomeReference.updateMany({
      data: { attempt: args.attempt, result: result as never, state: 'DONE' },
      where: {
        connectionId: args.key.connectionId,
        nodeId: args.key.nodeId,
        runId: args.key.runId,
      },
    });
    return result;
  } catch (err) {
    if (definitelyNotSent(err)) {
      await releaseOutcome(args.key);
    }
    throw err;
  }
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
