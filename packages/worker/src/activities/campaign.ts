/**
 * Activities behind `CampaignWorkflow`: they keep a campaign's rows true to what its children did.
 *
 * Every write is idempotent under Temporal retries and under a duplicate delivery, and none of
 * them can move a finished row:
 *
 *  - a target write is an `updateMany` whose `where` carries the target's `teamId` (the tenant
 *    key, frozen at launch) and a state predicate. A count of 0 means a retry already landed, or
 *    the target is already terminal, and is a no-op;
 *  - a campaign write is an `update` by id with a `state: { notIn: terminal }` predicate; the
 *    "no such row" error (P2025) is the same no-op.
 *
 * A child's outcome is mapped by `campaignTargetOutcome` (shared, pure). The mapper cannot import
 * the worker's credential masking, so the activity passes `maskCredentialShapes` in.
 */
import { prisma } from '@auto-swe/shared/db';
import {
  CAMPAIGN_TERMINAL_STATES,
  type CampaignTargetStateName,
  campaignFinalState,
  campaignTargetOutcome,
} from '@auto-swe/shared/lib/campaignOutcome';
import type { WorkflowResult } from '@auto-swe/shared/types/workflow';
import { maskCredentialShapes } from '../lib/redactToken.js';

/** States a target may still be moved out of. */
const OPEN_TARGET_STATES = ['PENDING', 'RUNNING'] as const;

export interface RecordCampaignTargetStartedInput {
  campaignId: string;
  connectionId: string;
  teamId: string;
  childWorkflowId: string;
}

export interface RecordCampaignTargetResultInput {
  campaignId: string;
  connectionId: string;
  teamId: string;
  result: WorkflowResult;
  /** The campaign was cancelled by the time this child ended. */
  cancelled: boolean;
}

export interface FinalizeCampaignInput {
  campaignId: string;
  cancelled: boolean;
  /** Every target that ran, with the result the workflow holds for it. */
  results: Array<{ connectionId: string; teamId: string; result: WorkflowResult }>;
  /** Targets that were still queued when the scheduler stopped. */
  notStarted: Array<{ connectionId: string; teamId: string }>;
}

function isNoRowError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'P2025';
}

/** The row data for one child's outcome. */
function outcomeData(result: WorkflowResult, cancelled: boolean) {
  const o = campaignTargetOutcome(result, { cancelled, mask: maskCredentialShapes });
  return {
    data: {
      failureReason: o.failureReason,
      finishedAt: new Date(),
      path: o.path,
      prNumber: o.prNumber,
      prUrl: o.prUrl,
      state: o.state,
      verification: o.verification,
    },
    outcome: o,
  };
}

async function writeTargetResult(input: {
  campaignId: string;
  connectionId: string;
  teamId: string;
  result: WorkflowResult;
  cancelled: boolean;
}): Promise<CampaignTargetStateName> {
  const { data, outcome } = outcomeData(input.result, input.cancelled);
  await prisma.campaignTarget.updateMany({
    data,
    where: {
      campaignId: input.campaignId,
      connectionId: input.connectionId,
      state: { in: [...OPEN_TARGET_STATES] },
      teamId: input.teamId,
    },
  });
  return outcome.state;
}

/** PENDING to RUNNING when the target's child is about to start. */
export async function recordCampaignTargetStarted(
  input: RecordCampaignTargetStartedInput
): Promise<void> {
  await prisma.campaignTarget.updateMany({
    data: { childWorkflowId: input.childWorkflowId, startedAt: new Date(), state: 'RUNNING' },
    where: {
      campaignId: input.campaignId,
      connectionId: input.connectionId,
      state: 'PENDING',
      teamId: input.teamId,
    },
  });
}

/** Record one child's outcome. A rejected child arrives as a synthesized FAILED result. */
export async function recordCampaignTargetResult(
  input: RecordCampaignTargetResultInput
): Promise<void> {
  await writeTargetResult(input);
}

/** STARTING to RUNNING. It never moves a campaign out of CANCELLING or a terminal state. */
export async function recordCampaignState(campaignId: string, state: 'RUNNING'): Promise<void> {
  try {
    await prisma.campaign.update({
      data: { state },
      where: { id: campaignId, state: 'STARTING' },
    });
  } catch (err) {
    if (!isNoRowError(err)) {
      throw err;
    }
  }
}

/**
 * Close the campaign. Re-applies every result (an idempotent reconcile, for a record activity that
 * failed), marks the targets that never started, and sets the campaign's final state.
 *
 * `notStarted` targets are CANCELLED when the campaign was cancelled and SKIPPED otherwise. A
 * child that finished before a cancel keeps its PR_OPENED / NOT_AFFECTED outcome. The final state
 * is computed from the same outcomes the rows were given, so it needs no read of the target table.
 * Returns it, so the workflow reports what the database says.
 */
export async function finalizeCampaign(
  input: FinalizeCampaignInput
): Promise<'COMPLETED' | 'COMPLETED_WITH_FAILURES' | 'CANCELLED'> {
  const states: CampaignTargetStateName[] = [];
  for (const r of input.results) {
    states.push(
      await writeTargetResult({
        campaignId: input.campaignId,
        cancelled: input.cancelled,
        connectionId: r.connectionId,
        result: r.result,
        teamId: r.teamId,
      })
    );
  }
  const unstartedState: CampaignTargetStateName = input.cancelled ? 'CANCELLED' : 'SKIPPED';
  for (const t of input.notStarted) {
    await prisma.campaignTarget.updateMany({
      data: {
        failureReason: input.cancelled ? null : 'the campaign ended before this target started',
        finishedAt: new Date(),
        state: unstartedState,
      },
      where: {
        campaignId: input.campaignId,
        connectionId: t.connectionId,
        state: 'PENDING',
        teamId: t.teamId,
      },
    });
    states.push(unstartedState);
  }
  const finalState = campaignFinalState(states, input.cancelled);
  try {
    await prisma.campaign.update({
      data: { completedAt: new Date(), state: finalState },
      where: { id: input.campaignId, state: { notIn: [...CAMPAIGN_TERMINAL_STATES] } },
    });
  } catch (err) {
    if (!isNoRowError(err)) {
      throw err;
    }
  }
  return finalState;
}
