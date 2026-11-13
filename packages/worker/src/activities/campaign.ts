/**
 * Activities behind `CampaignWorkflow`: they keep a campaign's rows true to what its children did.
 *
 * Every write is idempotent under Temporal retries and under a duplicate delivery, and none of
 * them can move a finished row:
 *
 *  - a target write is an `updateMany` keyed on the target row's id, whose `where` also carries
 *    the target's `teamId` (the tenant key, frozen at launch) and a state predicate. It is never
 *    keyed on the repository: deleting one sets the row's `connectionId` to NULL. A count of 0 means a retry already landed, or
 *    the target is already terminal, and is a no-op;
 *  - a campaign write is an `update` by id with a `state: { notIn: terminal }` predicate; the
 *    "no such row" error (P2025) is the same no-op.
 *
 * A child's outcome is mapped by `campaignTargetOutcome` (shared, pure). The mapper cannot import
 * the worker's credential masking, so the activity passes `maskCredentialShapes` in.
 */
import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import {
  CAMPAIGN_TERMINAL_STATES,
  type CampaignTargetStateName,
  campaignFinalState,
  campaignTargetOutcome,
} from '@auto-swe/shared/lib/campaignOutcome';
import type { CampaignTargetInput, WorkflowResult } from '@auto-swe/shared/types/workflow';
import { maskCredentialShapes } from '../lib/redactToken.js';

/** States a target may still be moved out of. */
const OPEN_TARGET_STATES = ['PENDING', 'RUNNING'] as const;

export interface RecordCampaignTargetStartedInput {
  campaignId: string;
  /** The `CampaignTarget` row; writes are keyed on it, never on the (nullable) repository. */
  targetId: string;
  connectionId: string;
  teamId: string;
  childWorkflowId: string;
}

export interface RecordCampaignTargetResultInput {
  campaignId: string;
  targetId: string;
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
  results: Array<{
    targetId: string;
    connectionId: string;
    teamId: string;
    result: WorkflowResult;
  }>;
  /** Targets that were still queued when the scheduler stopped. */
  notStarted: Array<{ targetId: string; connectionId: string; teamId: string }>;
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
  targetId: string;
  teamId: string;
  result: WorkflowResult;
  cancelled: boolean;
}): Promise<CampaignTargetStateName> {
  const { data, outcome } = outcomeData(input.result, input.cancelled);
  await prisma.campaignTarget.updateMany({
    data,
    where: {
      campaignId: input.campaignId,
      id: input.targetId,
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
      id: input.targetId,
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
        result: r.result,
        targetId: r.targetId,
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
        id: t.targetId,
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

// ── Re-checking the launch before each child starts ──

export interface AuthorizeCampaignTargetsInput {
  campaignId: string;
  /** The launcher every child acts as (`CampaignWorkflowInput.launchedById`). */
  launchedById: string;
  /** The targets about to start, in start order. */
  targets: Array<Pick<CampaignTargetInput, 'connectionId' | 'teamId'>>;
}

export interface AuthorizeCampaignTargetsResult {
  /**
   * Set when nothing more may start at all: the campaign's kill switch is off for its owning team,
   * or the launcher may no longer launch it. Every target in this batch and every one still
   * queued ends with this reason, and no child is started.
   */
  stopReason?: string;
  /**
   * Set with `stopReason` when the campaign row says it was cancelled (CANCELLING or CANCELLED):
   * a cancel whose signal never reached the execution, or one recorded before it started. The
   * workflow then stops as the cancel signal stops it, rather than ending its targets SKIPPED.
   */
  cancelled?: true;
  /** One verdict per target in the batch, in its order. Ignored when `stopReason` is set. */
  verdicts: Array<{ connectionId: string; allowed: boolean; reason?: string }>;
}

const TEAM_LEAD_ROLES: ReadonlySet<string> = new Set(['LEAD', 'ADMIN']);

/**
 * The campaign states in which a child may still start. STARTING is included because the
 * workflow's own STARTING-to-RUNNING write is best effort; every other state stops the campaign:
 * CANCELLING and CANCELLED as a cancel, and a terminal state written by anything else because no
 * campaign that is already final may grow a child.
 */
const STARTABLE_CAMPAIGN_STATES: ReadonlySet<string> = new Set(['STARTING', 'RUNNING']);
const CANCELLED_CAMPAIGN_STATES: ReadonlySet<string> = new Set(['CANCELLING', 'CANCELLED']);

/**
 * The launch decision, re-made for the targets about to start. A campaign starts its children
 * over days (its workflow may run 30), each as the launcher, so what the launch route checked once
 * is checked again here, right before a child exists:
 *
 *  - for the whole campaign: the campaign row exists and is still STARTING or RUNNING (a
 *    CANCELLING or CANCELLED row stops it as a cancel, whether or not the cancel signal reached
 *    this execution), the launcher's account is active, the owning team and the organization are
 *    active, a non-admin launcher is still a member of the organization, the launcher still leads
 *    the owning team (or is a platform ADMIN), and `workflow.campaignsEnabled` is still on for
 *    the owning team. A failure stops every target not yet started;
 *  - for each target: the repository still exists, is active and is a git repository, is still
 *    owned by the team it had at launch, in the campaign's organization, that team and its
 *    organization are active, and the team still has `workflow.campaignsEnabled` on and the
 *    launcher as a LEAD (or the launcher is a platform ADMIN). A failure ends that target
 *    unstarted.
 *
 * Not re-checked here: the GitHub permission gate (it judges a request's token, and a worker has
 * none), the organization and team budgets (each child is metered as it runs) and the size limits
 * (frozen at launch). Reads only, so a retry is harmless; the workflow decides from the verdict.
 */
export async function authorizeCampaignTargets(
  input: AuthorizeCampaignTargetsInput
): Promise<AuthorizeCampaignTargetsResult> {
  const stop = (stopReason: string): AuthorizeCampaignTargetsResult => ({
    stopReason,
    verdicts: [],
  });
  const campaign = await prisma.campaign.findUnique({
    select: {
      orgId: true,
      ownerTeam: { select: { isActive: true, organization: { select: { isActive: true } } } },
      ownerTeamId: true,
      state: true,
    },
    where: { id: input.campaignId },
  });
  if (!campaign) {
    return stop('the campaign no longer exists');
  }
  if (CANCELLED_CAMPAIGN_STATES.has(campaign.state)) {
    return { ...stop('the campaign was cancelled'), cancelled: true };
  }
  if (!STARTABLE_CAMPAIGN_STATES.has(campaign.state)) {
    return stop(`the campaign is already ${campaign.state}`);
  }
  const launcher = await prisma.user.findUnique({
    select: { isActive: true, role: true },
    where: { id: input.launchedById },
  });
  if (!launcher?.isActive) {
    return stop("the launcher's account is no longer active");
  }
  const isAdmin = launcher.role === 'ADMIN';
  if (!campaign.ownerTeam.isActive) {
    return stop('the owning team was deactivated');
  }
  if (!campaign.ownerTeam.organization.isActive) {
    return stop("the campaign's organization was deactivated");
  }
  if (!isAdmin) {
    // The launch requires it of a non-admin (the ledger's source authorization), and every child
    // acts as the launcher inside this organization.
    const orgMember = await prisma.organizationMembership.findUnique({
      select: { userId: true },
      where: { userId_orgId: { orgId: campaign.orgId, userId: input.launchedById } },
    });
    if (!orgMember) {
      return stop("the launcher is no longer a member of the campaign's organization");
    }
  }

  const leads = new Map<string, boolean>();
  const leadsTeam = async (teamId: string): Promise<boolean> => {
    if (isAdmin) {
      return true;
    }
    const known = leads.get(teamId);
    if (known !== undefined) {
      return known;
    }
    const membership = await prisma.teamMembership.findUnique({
      select: { role: true },
      where: { userId_teamId: { teamId, userId: input.launchedById } },
    });
    const ok = membership !== null && TEAM_LEAD_ROLES.has(membership.role);
    leads.set(teamId, ok);
    return ok;
  };
  const enabled = new Map<string, boolean>();
  const enabledFor = async (teamId: string): Promise<boolean> => {
    const known = enabled.get(teamId);
    if (known !== undefined) {
      return known;
    }
    const on = await resolveSetting('workflow.campaignsEnabled', {
      orgId: campaign.orgId,
      teamId,
    });
    enabled.set(teamId, on);
    return on;
  };

  if (!(await leadsTeam(campaign.ownerTeamId))) {
    return stop('the launcher no longer leads the owning team');
  }
  if (!(await enabledFor(campaign.ownerTeamId))) {
    return stop('workflow.campaignsEnabled was turned off for the owning team');
  }

  const verdicts: AuthorizeCampaignTargetsResult['verdicts'] = [];
  for (const target of input.targets) {
    const refuse = (reason: string) =>
      verdicts.push({ allowed: false, connectionId: target.connectionId, reason });
    const repo = await prisma.connection.findUnique({
      select: {
        isActive: true,
        team: {
          select: { isActive: true, organization: { select: { isActive: true } }, orgId: true },
        },
        teamId: true,
        type: true,
      },
      where: { id: target.connectionId },
    });
    if (!repo?.isActive || repo.type !== 'git_repo') {
      refuse('the repository is no longer an active git repository');
    } else if (repo.teamId !== target.teamId) {
      refuse('the repository moved to another team after the launch');
    } else if (repo.team?.orgId !== campaign.orgId) {
      refuse("the repository is no longer in the campaign's organization");
    } else if (!repo.team.isActive) {
      refuse("the repository's team was deactivated");
    } else if (!repo.team.organization.isActive) {
      refuse("the repository's organization was deactivated");
    } else if (!(await enabledFor(target.teamId))) {
      refuse("workflow.campaignsEnabled was turned off for the repository's team");
    } else if (!(await leadsTeam(target.teamId))) {
      refuse('the launcher no longer leads the team that owns the repository');
    } else {
      verdicts.push({ allowed: true, connectionId: target.connectionId });
    }
  }
  return { verdicts };
}
