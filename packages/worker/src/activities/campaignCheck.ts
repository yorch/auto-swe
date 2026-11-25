/**
 * The campaign check and target discovery (docs/specs/2026-11-25-campaigns-as-tracked-goals.md §3,
 * §5): "does this repository satisfy the goal?", asked of the repository's base branch.
 *
 * A check is a recipe's read-only entry point run in the shell-step sandbox
 * (`runShellCheck`): an allowlisted image, the base branch cloned into a volume that holds no
 * credential, no network, no commit and no push, and no model. It takes seconds, so it is an
 * activity of the reconciler and not a child run.
 *
 * It fails closed. Anything short of a clear answer (the sandbox did not start, the script was
 * killed, it exited with a code that is neither "satisfied" nor "not satisfied", or its evidence
 * line is missing) is "could not run": the target's state does not move, the reason is recorded,
 * and a later pass tries again. A check never decides a repository is satisfied, or has regressed,
 * on a guess.
 */

import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { boundFailureReason } from '@auto-swe/shared/lib/campaignOutcome';
import { recipeSupportsCheck } from '@auto-swe/shared/lib/campaignRecipes';
import {
  DEFAULT_CAMPAIGN_REGRESSION_LIMIT,
  isTargetFinal,
  normalizeTargetState,
  type TargetState,
  transitionTarget,
} from '@auto-swe/shared/lib/campaignState';
import { repoMemberWhere } from '@auto-swe/shared/lib/repoMembership';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { can, isPlatformAdmin, userActor } from '@auto-swe/shared/permissions';
import { CancelledFailure, heartbeat } from '@temporalio/activity';
import { assertCurrentWorkflowOwnsCampaign } from '../lib/campaignIdentity.js';
import {
  buildRecipeCheckCommand,
  interpretRecipeCheck,
  recipeRuntime,
} from '../lib/campaignRecipes.js';
import type {
  DiscoverCampaignTargetsInput,
  DiscoverCampaignTargetsResult,
  DiscoveredCandidate,
  RunCampaignCheckInput,
  RunCampaignCheckResult,
} from '../lib/campaignReconcilerTypes.js';
import { maskCredentialShapes } from '../lib/redactToken.js';
import { MERGE_NOT_SATISFIED_REASON } from '../workflows/campaignReconcilerPass.js';
import { runShellCheck, type ShellCheckInput, type ShellCheckResult } from './shellStep.js';

/** The campaign states in which a check may run: it is a rescan, and a paused campaign has none. */
const CHECKABLE_CAMPAIGN_STATES = new Set(['STARTING', 'ACTIVE', 'MONITORING', 'RUNNING']);
/** The targets a check is run for; every other state is moved by a run or a person. */
const CHECKABLE_TARGET_STATES = new Set<TargetState>(['MERGED', 'SATISFIED']);

/** Repositories one discovery call checks before it hands the walk back to the workflow. */
export const DISCOVERY_CHUNK = 25;
/** Candidates one scope walk returns at most, so the workflow's history stays bounded. */
export const DISCOVERY_MAX_CANDIDATES = 500;

export interface CheckDeps {
  run: (input: ShellCheckInput) => Promise<ShellCheckResult>;
}

const defaultDeps: CheckDeps = { run: runShellCheck };

const REASON_MAX = 200;

function safeReason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return boundFailureReason(text, maskCredentialShapes).slice(0, REASON_MAX);
}

type CheckOutcome =
  | {
      status: 'satisfied' | 'not-satisfied';
      evidence: Record<string, unknown>;
      baseSha: string | null;
    }
  | {
      status: 'could-not-run';
      reason: string;
      evidence: Record<string, unknown>;
      baseSha: string | null;
    };

/** Run one repository's check. Never throws except for a cancellation. */
async function checkRepository(
  recipeRef: string,
  recipeParams: unknown,
  repoId: string,
  deps: CheckDeps
): Promise<CheckOutcome> {
  if (!recipeSupportsCheck(recipeRef)) {
    return {
      baseSha: null,
      evidence: { kind: 'cannot-check' },
      reason: 'the recipe has no check',
      status: 'could-not-run',
    };
  }
  let command: string;
  let runtime: ReturnType<typeof recipeRuntime>;
  try {
    command = buildRecipeCheckCommand(recipeRef, recipeParams);
    runtime = recipeRuntime(recipeRef as Parameters<typeof recipeRuntime>[0]);
  } catch (err) {
    return {
      baseSha: null,
      evidence: { kind: 'cannot-check' },
      reason: safeReason(err),
      status: 'could-not-run',
    };
  }
  let ran: ShellCheckResult;
  try {
    ran = await deps.run({
      command,
      image: runtime.image,
      repoId,
      timeoutMs: runtime.timeoutMs,
    });
  } catch (err) {
    if (err instanceof CancelledFailure) {
      throw err;
    }
    return {
      baseSha: null,
      evidence: { kind: 'cannot-check' },
      reason: `the check could not run: ${safeReason(err)}`,
      status: 'could-not-run',
    };
  }
  if (ran.refused) {
    return {
      baseSha: ran.baseSha,
      evidence: { kind: 'cannot-check' },
      reason: `the check could not run: ${boundFailureReason(ran.refused, maskCredentialShapes).slice(0, REASON_MAX)}`,
      status: 'could-not-run',
    };
  }
  const result = interpretRecipeCheck({ exitCode: ran.exitCode, stdout: ran.stdout });
  if (result.status === 'could-not-run') {
    return {
      baseSha: ran.baseSha,
      evidence: { exitCode: result.exitCode, kind: 'cannot-check' },
      reason: result.reason,
      status: 'could-not-run',
    };
  }
  return {
    baseSha: ran.baseSha,
    evidence: { ...result.evidence },
    status: result.status,
  };
}

/**
 * Run the check of one `MERGED` or `SATISFIED` target and apply the answer.
 *
 * `satisfied` finishes a `MERGED` target; `not-satisfied` sends a `SATISFIED` one back to
 * `PENDING` with `regressions + 1` (or to `NEEDS_ATTENTION` past the regression limit) and a
 * `MERGED` one to `NEEDS_ATTENTION`, because the merge did not do what the campaign asked. The
 * transition is `transitionTarget`'s, and the write is conditional on the state it was read in, so
 * a target a person moved meanwhile is left alone. Evidence, the time and the checked sha are
 * recorded for every answer, `could-not-run` included; that one moves nothing else.
 */
export async function runCampaignCheck(
  input: RunCampaignCheckInput,
  deps: CheckDeps = defaultDeps
): Promise<RunCampaignCheckResult> {
  const { campaignId, targetId } = input;
  assertCurrentWorkflowOwnsCampaign(campaignId);
  const skipped = (
    reason: string,
    target?: { state: TargetState; regressions: number; lastCheckedAt: Date | null }
  ): RunCampaignCheckResult => ({
    changed: false,
    lastCheckedAt: target?.lastCheckedAt?.getTime() ?? null,
    reason,
    regressions: target?.regressions ?? 0,
    state: target ? normalizeTargetState(target.state) : 'PENDING',
    status: 'skipped',
    targetId,
  });

  const campaign = await prisma.campaign.findUnique({
    select: { orgId: true, recipeParams: true, recipeRef: true, state: true },
    where: { id: campaignId },
  });
  if (!campaign) {
    return skipped('the campaign no longer exists');
  }
  const target = await prisma.campaignTarget.findFirst({
    select: {
      connectionId: true,
      lastCheckedAt: true,
      regressions: true,
      state: true,
      teamId: true,
    },
    where: { campaign: { orgId: campaign.orgId }, campaignId, id: targetId },
  });
  if (!target) {
    return skipped('the target no longer exists');
  }
  const current = target.state as TargetState;
  if (!CHECKABLE_CAMPAIGN_STATES.has(campaign.state)) {
    return skipped('the campaign is not active', { ...target, state: current });
  }
  if (!CHECKABLE_TARGET_STATES.has(normalizeTargetState(current)) || !target.connectionId) {
    return skipped('the target is not waiting for a check', { ...target, state: current });
  }
  if (!campaign.recipeRef) {
    return skipped('the campaign has no recipe', { ...target, state: current });
  }

  const outcome = await checkRepository(
    campaign.recipeRef,
    campaign.recipeParams,
    target.connectionId,
    deps
  );
  const now = new Date();
  const evidence = {
    ...outcome.evidence,
    checkedAt: now.toISOString(),
    ref: campaign.recipeRef,
  } as Record<string, string | number | null>;

  if (outcome.status === 'could-not-run') {
    await prisma.campaignTarget.updateMany({
      data: {
        evidence: { ...evidence, reason: outcome.reason },
        lastCheckedAt: now,
        ...(outcome.baseSha ? { lastCheckedSha: outcome.baseSha } : {}),
      },
      where: { campaignId, id: targetId, state: current, teamId: target.teamId },
    });
    return {
      changed: false,
      lastCheckedAt: now.getTime(),
      reason: outcome.reason,
      regressions: target.regressions,
      state: normalizeTargetState(current),
      status: 'could-not-run',
      targetId,
    };
  }

  const satisfied = outcome.status === 'satisfied';
  const next = transitionTarget(
    { regressions: target.regressions, state: current },
    { satisfied, type: 'check' },
    { regressionLimit: DEFAULT_CAMPAIGN_REGRESSION_LIMIT }
  );
  const moves = next.accepted && next.state !== normalizeTargetState(current);
  const failureReason: string | null | undefined = !moves
    ? undefined
    : next.state === 'NEEDS_ATTENTION'
      ? normalizeTargetState(current) === 'MERGED'
        ? MERGE_NOT_SATISFIED_REASON
        : `the check regressed more than ${DEFAULT_CAMPAIGN_REGRESSION_LIMIT} times after it was satisfied`
      : null;
  const moved = await prisma.campaignTarget.updateMany({
    data: {
      evidence,
      lastCheckedAt: now,
      ...(outcome.baseSha ? { lastCheckedSha: outcome.baseSha } : {}),
      ...(moves
        ? {
            regressions: next.regressions,
            staleSince: null,
            state: next.state,
            ...(isTargetFinal(next.state)
              ? { finishedAt: now }
              : next.state === 'PENDING'
                ? { finishedAt: null }
                : {}),
            ...(failureReason !== undefined ? { failureReason } : {}),
          }
        : {}),
    },
    where: { campaignId, id: targetId, state: current, teamId: target.teamId },
  });
  const landed = moved.count > 0;
  return {
    changed: landed && moves,
    ...(landed && moves && failureReason !== undefined ? { failureReason } : {}),
    lastCheckedAt: landed ? now.getTime() : (target.lastCheckedAt?.getTime() ?? null),
    regressions: landed && moves ? next.regressions : target.regressions,
    state: landed && moves ? next.state : normalizeTargetState(current),
    status: outcome.status,
    targetId,
  };
}

// ── Discovery ──

/**
 * Walk one chunk of the campaign's scope: the repositories of a team, or of the campaign's
 * organization, that the launcher may see, each checked once. Returns the candidates that are not
 * yet targets or proposals and are not satisfied, in a stable order, for the workflow to diff
 * (`diffDiscovery`): it adds the reachable ones up to the target limit and records the rest as
 * proposals. `cursor` is the offset to resume from; the answer's `nextCursor` is null when the
 * scope has been walked to its end.
 *
 * A repository the launcher cannot see is never checked and never named. One they can see but not
 * start work in is checked and reported unreachable, with the reason, so the owning team can
 * decide; nothing is ever started from here.
 */
export async function discoverCampaignTargets(
  input: DiscoverCampaignTargetsInput,
  deps: CheckDeps = defaultDeps
): Promise<DiscoverCampaignTargetsResult> {
  const { campaignId, cursor } = input;
  assertCurrentWorkflowOwnsCampaign(campaignId);
  const campaign = await prisma.campaign.findUnique({
    select: {
      launchedById: true,
      orgId: true,
      recipeParams: true,
      recipeRef: true,
      scopeId: true,
      scopeKind: true,
      state: true,
    },
    where: { id: campaignId },
  });
  const done: DiscoverCampaignTargetsResult = { candidates: [], nextCursor: null };
  if (
    !campaign?.scopeKind ||
    !campaign.recipeRef ||
    !recipeSupportsCheck(campaign.recipeRef) ||
    !campaign.launchedById ||
    !CHECKABLE_CAMPAIGN_STATES.has(campaign.state)
  ) {
    return done;
  }
  const launcher = await prisma.user.findUnique({
    select: { isActive: true, role: true },
    where: { id: campaign.launchedById },
  });
  if (!launcher?.isActive) {
    return done;
  }
  const isAdmin = isPlatformAdmin(launcher);
  const actor = userActor({ role: launcher.role, sub: campaign.launchedById });

  const scopeWhere =
    campaign.scopeKind === 'TEAM'
      ? campaign.scopeId
        ? { teamId: campaign.scopeId }
        : null
      : { team: { orgId: campaign.orgId } };
  if (!scopeWhere) {
    return done;
  }
  const where = {
    ...scopeWhere,
    isActive: true,
    team: { isActive: true, orgId: campaign.orgId },
    type: 'git_repo',
    ...(isAdmin ? {} : repoMemberWhere({ userId: campaign.launchedById })),
  };
  const [known, knownProposals, repos] = await Promise.all([
    prisma.campaignTarget.findMany({
      select: { connectionId: true },
      where: { campaign: { orgId: campaign.orgId }, campaignId },
    }),
    prisma.campaignProposal.findMany({ select: { connectionId: true }, where: { campaignId } }),
    // The filter is built above: the campaign's scope, its organization, and, for a launcher who is
    // not a platform admin, `repoMemberWhere` for that launcher (membership or a team share).
    runUnscoped(
      'discovery is scoped to the campaign scope, its organization and the launcher membership',
      ['Connection'],
      () =>
        prisma.connection.findMany({
          orderBy: { id: 'asc' },
          select: { id: true, organizationName: true, repoName: true, teamId: true },
          skip: cursor,
          take: DISCOVERY_CHUNK,
          where: where as never,
        })
    ),
  ]);
  const skip = new Set<string>([
    ...known.flatMap((k) => (k.connectionId ? [k.connectionId] : [])),
    ...knownProposals.map((p) => p.connectionId),
  ]);

  const enabled = new Map<string, boolean>();
  const mayLaunch = new Map<string, boolean>();
  const reachability = async (teamId: string): Promise<{ ok: boolean; reason?: string }> => {
    if (!enabled.has(teamId)) {
      enabled.set(
        teamId,
        await resolveSetting('workflow.campaignsEnabled', { orgId: campaign.orgId, teamId })
      );
    }
    if (!enabled.get(teamId)) {
      return { ok: false, reason: "campaigns are not enabled for the repository's team" };
    }
    if (!mayLaunch.has(teamId)) {
      mayLaunch.set(
        teamId,
        isAdmin || (await can(prisma, actor, 'team.launch.multi-repo', { teamId })).allowed
      );
    }
    return mayLaunch.get(teamId)
      ? { ok: true }
      : { ok: false, reason: 'the launcher does not lead the team that owns the repository' };
  };

  const candidates: DiscoveredCandidate[] = [];
  for (const repo of repos) {
    heartbeat('campaign discovery: checking a repository');
    if (skip.has(repo.id)) {
      continue;
    }
    const outcome = await checkRepository(campaign.recipeRef, campaign.recipeParams, repo.id, deps);
    if (outcome.status === 'satisfied') {
      continue;
    }
    const reach = await reachability(repo.teamId);
    candidates.push({
      connectionId: repo.id,
      label: `${repo.organizationName ?? '?'}/${repo.repoName ?? repo.id}`,
      reachable: reach.ok,
      satisfied: outcome.status === 'not-satisfied' ? false : null,
      teamId: repo.teamId,
      ...(reach.ok ? {} : { unreachableReason: reach.reason }),
    });
    if (candidates.length >= DISCOVERY_MAX_CANDIDATES) {
      return { candidates, nextCursor: null };
    }
  }
  return {
    candidates,
    nextCursor: repos.length < DISCOVERY_CHUNK ? null : cursor + repos.length,
  };
}
