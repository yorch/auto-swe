import type { PlatformRole, PrismaClient } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import type {
  CampaignRefusalCode,
  CampaignStartAttemptResponse,
} from '@auto-swe/shared/lib/campaignApi';
import { recipeSupportsCheck } from '@auto-swe/shared/lib/campaignRecipes';
import {
  type CampaignGateValue,
  decideSchedule,
  describeBlockReason,
  normalizeTargetState,
  type TargetState,
} from '@auto-swe/shared/lib/campaignState';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { generateBranchName } from '@auto-swe/shared/lib/workflowId';
import { can as sharedCan, userActor } from '@auto-swe/shared/permissions';
import {
  BUDGET_TIERS,
  type BudgetTier,
  type RepoWorkRequest,
} from '@auto-swe/shared/types/workflow';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { resolveDefaultTemplate } from '../routes/workRequests.js';
import { writeAuditLog } from './auditLog.js';
import { decideTargetLaunch, loadLaunchRepos } from './campaignAccess.js';
import { checkPushPermission } from './orchestrationAccess.js';
import { isOrgMember } from './orgAccess.js';
import { launchTrackedWorkflow } from './workflowLaunch.js';

/**
 * Start one attempt of one campaign target (`POST /campaigns/:id/targets/:targetId/attempts`,
 * spec §4). The worker calls it with a campaign token; the acting identity is the campaign's
 * launcher, read from the campaign row at every call, never from the token.
 *
 * The checks run in the order the spec gives and stop at the first refusal, each answering one
 * code of `CAMPAIGN_REFUSAL_CODES`:
 *
 *   1. CAMPAIGN_NOT_ACTIVE / CAMPAIGNS_DISABLED  the campaign is reconciled, `ACTIVE` or `STARTING`,
 *      and `workflow.campaignsEnabled` still holds for its team and the target's team.
 *   2. LAUNCHER_UNAVAILABLE  the launcher's account, organization membership and lead of the
 *      owning team still hold.
 *   3. TARGET_UNAVAILABLE / TARGET_NOT_STARTABLE  the repository exists, is active, is a git
 *      repository and is owned by the team the target recorded; the target is `PENDING` or `BLOCKED`.
 *   4. GATE_CLOSED / MAX_PARALLEL / MAX_OPEN_PULL_REQUESTS  `decideSchedule`, read first without a
 *      lock (so a refusal for step 4 outranks one for step 5) and then again under a row lock on the
 *      campaign, so two concurrent starts cannot both pass the same limit.
 *   5. LAUNCH_REFUSED / PUSH_PERMISSION_REQUIRED / BUDGET_EXCEEDED  the standard launch decision
 *      as the launcher, GitHub push permission asked live, and the campaign's own budget.
 *   6. The run's ledger rows, the attempt and the target's `RUNNING` state are written in one
 *      transaction under that lock, and the child run is started.
 *
 * A call with an idempotency key already answered is answered again, before any check: the limits
 * would otherwise count the attempt it started against the retry.
 */

export type AttemptResult =
  | { ok: true; status: 200 | 201; data: CampaignStartAttemptResponse }
  | {
      ok: false;
      status: 404 | 409;
      code: CampaignRefusalCode | 'CAMPAIGN_NOT_FOUND';
      message: string;
    };

const refuse = (
  code: CampaignRefusalCode,
  message: string
): { ok: false; status: 409; code: CampaignRefusalCode; message: string } => ({
  code,
  message,
  ok: false,
  status: 409,
});

const STARTABLE: readonly TargetState[] = ['PENDING', 'BLOCKED'];

/** `CAMPAIGN-<first 12 hex digits of the id>`: the children's ticket id. */
export function campaignTicketId(campaignId: string): string {
  return `CAMPAIGN-${campaignId.replaceAll('-', '').slice(0, 12)}`;
}

/**
 * The child run's workflow id: `<campaign workflow id>-<connectionId>` for the first attempt and
 * `…-<n>` after it, so every attempt of a target is a distinct execution.
 */
export function attemptWorkflowId(
  campaignWorkflowId: string,
  connectionId: string,
  n: number
): string {
  return n > 1
    ? `${campaignWorkflowId}-${connectionId}-${n}`
    : `${campaignWorkflowId}-${connectionId}`;
}

/** The first day of the current month, UTC: the start of the window a campaign's budget counts. */
function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * What the campaign's attempts have spent this month: the spend ledger of every attempt started in
 * the month. Best-effort for runs in flight, which have accrued only so far (spec §8).
 */
export async function campaignMonthSpendUsd(
  prisma: PrismaClient,
  campaignId: string,
  now: Date = new Date()
): Promise<number> {
  const attempts = await prisma.campaignAttempt.findMany({
    select: { childWorkflowId: true },
    where: { startedAt: { gte: monthStart(now) }, target: { campaignId } },
  });
  const ids = attempts.flatMap((a) => (a.childWorkflowId ? [a.childWorkflowId] : []));
  if (ids.length === 0) {
    return 0;
  }
  const sum = await prisma.activeWorkflow.aggregate({
    _sum: { costUsdAccrued: true },
    where: { temporalWorkflowId: { in: ids } },
  });
  return sum._sum.costUsdAccrued ?? 0;
}

interface AttemptContext {
  fastify: FastifyInstance;
  log: FastifyBaseLogger;
  campaignId: string;
  targetId: string;
  idempotencyKey?: string | undefined;
}

const idempotencyColumn = (c: AttemptContext) =>
  c.idempotencyKey
    ? `campaign-attempt:${c.campaignId}:${c.targetId}:${c.idempotencyKey}`.slice(0, 500)
    : null;

/** The attempt a call with this key already started, if any. */
async function findReplay(
  c: AttemptContext,
  launcherId: string
): Promise<CampaignStartAttemptResponse | null> {
  const key = idempotencyColumn(c);
  if (!key) {
    return null;
  }
  const prior = await c.fastify.prisma.runInput.findFirst({
    select: { activeWorkflows: { select: { assignedBranch: true, temporalWorkflowId: true } } },
    where: { idempotencyKey: key, requestedById: launcherId },
  });
  const wf = prior?.activeWorkflows[0];
  if (!wf) {
    return null;
  }
  const attempt = await c.fastify.prisma.campaignAttempt.findFirst({
    select: { id: true, n: true, runId: true },
    where: { childWorkflowId: wf.temporalWorkflowId, targetId: c.targetId },
  });
  return attempt
    ? {
        attemptId: attempt.id,
        branch: wf.assignedBranch,
        n: attempt.n,
        runId: attempt.runId,
        workflowId: wf.temporalWorkflowId,
      }
    : null;
}

/** The `budget` tier the campaign was launched with, read from the launch request stored once. */
async function launchedBudgetTier(
  prisma: PrismaClient,
  workRequestId: string
): Promise<BudgetTier | undefined> {
  const stored = await prisma.runInput.findUnique({
    select: { requestPayload: true },
    where: { id: workRequestId },
  });
  try {
    const parsed = JSON.parse(stored?.requestPayload ?? '') as { budget?: unknown };
    return (BUDGET_TIERS as readonly unknown[]).includes(parsed.budget)
      ? (parsed.budget as BudgetTier)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function startCampaignAttempt(c: AttemptContext): Promise<AttemptResult> {
  const { fastify } = c;
  const prisma = fastify.prisma;

  const campaign = await prisma.campaign.findFirst({
    select: {
      description: true,
      gate: true,
      id: true,
      launchedById: true,
      maxOpenPullRequests: true,
      maxParallel: true,
      orgId: true,
      ownerTeamId: true,
      plan: true,
      recipeParams: true,
      recipeRef: true,
      state: true,
      templateId: true,
      templateVersion: true,
      temporalWorkflowId: true,
      workflowKind: true,
      workRequestId: true,
    },
    where: { id: c.campaignId },
  });
  if (!campaign) {
    return { code: 'CAMPAIGN_NOT_FOUND', message: 'Campaign not found', ok: false, status: 404 };
  }
  const target = await runUnscoped(
    'the worker starts an attempt for the campaign the token names; the target is read by its own id',
    ['CampaignTarget'],
    () =>
      prisma.campaignTarget.findFirst({
        select: {
          brief: true,
          connectionId: true,
          id: true,
          repoLabel: true,
          startedAt: true,
          state: true,
          teamId: true,
        },
        where: { campaignId: campaign.id, id: c.targetId },
      })
  );
  if (!target) {
    return {
      code: 'TARGET_UNAVAILABLE',
      message: 'This target is not part of the campaign',
      ok: false,
      status: 404,
    };
  }
  const launcherId = campaign.launchedById;

  // A retried call is answered with its first call's attempt, before any check.
  if (launcherId) {
    const replay = await findReplay(c, launcherId);
    if (replay) {
      return { data: replay, ok: true, status: 200 };
    }
  }

  // 1. The campaign is reconciled and active, and the setting still holds for both teams.
  if (
    campaign.workflowKind !== 'RECONCILER' ||
    (campaign.state !== 'ACTIVE' && campaign.state !== 'STARTING')
  ) {
    return refuse('CAMPAIGN_NOT_ACTIVE', `The campaign is ${campaign.state} and starts no attempt`);
  }
  const repoRows = target.connectionId
    ? await loadLaunchRepos(prisma, launcherId ?? '', [target.connectionId])
    : [];
  const repo = repoRows[0];
  const targetCtx = {
    orgId: repo?.team.orgId ?? campaign.orgId,
    teamId: repo?.teamId ?? target.teamId,
  };
  const [ownerEnabled, targetEnabled] = await Promise.all([
    resolveSetting('workflow.campaignsEnabled', {
      orgId: campaign.orgId,
      teamId: campaign.ownerTeamId,
    }),
    resolveSetting('workflow.campaignsEnabled', targetCtx),
  ]);
  if (!ownerEnabled || !targetEnabled) {
    return refuse(
      'CAMPAIGNS_DISABLED',
      'Campaigns are not enabled (workflow.campaignsEnabled) for the owning team or the target’s team'
    );
  }

  // 2. The launcher: account, organization and the lead of the owning team.
  if (!launcherId) {
    return refuse('LAUNCHER_UNAVAILABLE', 'The campaign has no launcher; a LEAD must take it over');
  }
  const launcher = await prisma.user.findUnique({
    select: { id: true, isActive: true, role: true },
    where: { id: launcherId },
  });
  if (!launcher?.isActive) {
    return refuse('LAUNCHER_UNAVAILABLE', 'The launcher’s account is not active');
  }
  const actor = { role: launcher.role as PlatformRole, sub: launcher.id };
  if (!(await isOrgMember(prisma, actor, campaign.orgId))) {
    return refuse(
      'LAUNCHER_UNAVAILABLE',
      'The launcher no longer belongs to the campaign’s organization'
    );
  }
  if (
    !(
      await sharedCan(prisma, userActor(actor), 'team.launch.multi-repo', {
        teamId: campaign.ownerTeamId,
      })
    ).allowed
  ) {
    return refuse('LAUNCHER_UNAVAILABLE', 'The launcher no longer leads the owning team');
  }

  // 3. The target's repository, and the target itself.
  if (
    !target.connectionId ||
    !repo?.isActive ||
    repo.type !== 'git_repo' ||
    repo.teamId !== target.teamId
  ) {
    return refuse(
      'TARGET_UNAVAILABLE',
      'The repository no longer exists, is inactive, is not a git repository or changed owner'
    );
  }
  if (!STARTABLE.includes(normalizeTargetState(target.state as TargetState))) {
    return refuse('TARGET_NOT_STARTABLE', `The target is ${target.state}, not waiting to start`);
  }

  // 4 (unlocked read, so its refusal outranks step 5's; re-decided under the lock below).
  const hasCheck = recipeSupportsCheck(campaign.recipeRef);
  const gateRefusal = await decideGate(prisma, campaign, target.id, hasCheck);
  if (gateRefusal) {
    return gateRefusal;
  }

  // 5. The launch decision as the launcher, push permission asked live, the campaign's budget.
  const decision = await decideTargetLaunch(prisma, actor, repo, {
    gate: undefined,
    log: c.log,
  });
  if (!decision.ok) {
    return refuse('LAUNCH_REFUSED', `The launch is no longer authorized: ${decision.reason}`);
  }
  const push = await checkPushPermission(prisma, launcher.id, repo);
  if (!push.ok) {
    return refuse('PUSH_PERMISSION_REQUIRED', push.reason);
  }
  const budget = await resolveBudget(prisma, c.campaignId);
  if (budget.exceeded) {
    await pauseForBudget(c, campaign);
    return refuse(
      'BUDGET_EXCEEDED',
      `The campaign’s monthly budget of $${budget.cap} is spent; it is paused`
    );
  }

  // 6. Ledger rows, the attempt and the target's state, under the campaign's row lock.
  const priorN =
    (
      await prisma.campaignAttempt.aggregate({
        _max: { n: true },
        where: { targetId: target.id },
      })
    )._max.n ?? 0;
  const n = priorN + 1;
  const childWorkflowId = attemptWorkflowId(campaign.temporalWorkflowId, target.connectionId, n);
  const ticket = campaignTicketId(campaign.id);
  const { branchPrefix } = await resolveWorkflowDefaults();
  const branch =
    n > 1 ? `${branchPrefix}/${ticket}-${n}` : generateBranchName(ticket, branchPrefix);
  const tier = await launchedBudgetTier(prisma, campaign.workRequestId);

  const recipe = campaign.recipeRef
    ? (campaign.recipeParams as Record<string, unknown> | null)
    : null;
  const payload: Record<string, unknown> | null =
    campaign.recipeRef && recipe
      ? {
          connectionId: target.connectionId,
          packageName: recipe.packageName,
          recipe: campaign.recipeRef,
          targetVersion: recipe.targetVersion,
          ...(tier ? { budget: tier } : {}),
        }
      : campaign.plan === 'UNIFORM'
        ? { connectionId: target.connectionId, ...(tier ? { budget: tier } : {}) }
        : null;

  // A uniform or recipe campaign runs its pinned template; a planned one without a recipe runs the
  // default template of the repository's own team, as an epic's children do.
  let templateId = campaign.templateId;
  let templateVersion = campaign.templateVersion;
  if (campaign.plan === 'PLANNED' && !campaign.recipeRef) {
    const resolved = await resolveDefaultTemplate(prisma, repo.teamId, ticket);
    if (resolved) {
      templateId = resolved.templateId;
      templateVersion = resolved.version;
    }
  }

  const workRequestId = crypto.randomUUID();
  const description = target.brief ?? campaign.description;
  const requestPayload = JSON.stringify(payload ?? { connectionId: target.connectionId });
  const request: RepoWorkRequest = {
    ...(n > 1 ? { branchName: branch } : {}),
    ...(tier ? { budgetTier: tier } : {}),
    connectionId: target.connectionId,
    description,
    externalTicketId: ticket,
    launchedById: launcher.id,
    parentWorkflowId: campaign.temporalWorkflowId,
    ...(payload ? { payload } : {}),
    repoId: target.connectionId,
    requestPayload,
    workRequestId,
  };

  let refusal: { code: CampaignRefusalCode; message: string } | null = null;
  let attemptId = '';
  const previousState = target.state;
  const launch = await launchTrackedWorkflow(
    prisma,
    {
      activeWorkflow: {
        assignedBranch: branch,
        budgetTier: tier ?? 'STANDARD',
        currentStatus: 'IMPLEMENTING',
        parentWorkflowId: campaign.temporalWorkflowId,
        repoId: repo.id,
        temporalWorkflowId: childWorkflowId,
        workRequestId,
      },
      knowledgeSourceRepo: { orgId: repo.team.orgId, repoId: repo.id, teamId: repo.teamId },
      runInput: {
        connectionId: repo.id,
        description,
        externalTicketId: ticket,
        id: workRequestId,
        // The key is what answers a retried call with its first call's attempt.
        ...(idempotencyColumn(c) ? { idempotencyKey: idempotencyColumn(c) } : {}),
        ...(payload ? { payload: payload as object } : {}),
        requestedById: launcher.id,
        requestPayload,
        templateId,
        templateVersion,
        ticketIsSynthetic: true,
      },
    },
    async () => {
      try {
        await fastify.temporal.startRunnableWorkflow(childWorkflowId, {
          request,
          templateId,
          templateVersion,
        });
      } catch (err) {
        // The run never started: the attempt and the target's state go back as they were, so the
        // worker's retry starts a clean one.
        await prisma.campaignAttempt
          .deleteMany({ where: { id: attemptId } })
          .catch(() => undefined);
        await runUnscoped(
          'undoing the RUNNING state this call wrote for the target it started',
          ['CampaignTarget'],
          () =>
            prisma.campaignTarget.updateMany({
              data: { state: previousState as never },
              where: { id: target.id, state: 'RUNNING', teamId: target.teamId },
            })
        ).catch(() => undefined);
        throw err;
      }
    },
    {
      audit: { actor: { sub: launcher.id }, source: 'campaign-attempt', templateId },
      guard: async (tx) => {
        // CLAUDE.md §7 exception: Prisma cannot express SELECT … FOR UPDATE. The campaign row is the
        // serialization point for the gate and both limits, so two concurrent starts cannot pass
        // the same one. It is taken before any other lock of the launch and no transaction takes it
        // after another, so it adds no edge to the lock order (`lockOrder.ts`).
        await tx.$queryRaw`SELECT id FROM campaigns WHERE id = ${campaign.id}::uuid FOR UPDATE`;
        const current = await tx.campaign.findFirst({
          select: { state: true, workflowKind: true },
          where: { id: campaign.id },
        });
        if (
          current?.workflowKind !== 'RECONCILER' ||
          (current.state !== 'ACTIVE' && current.state !== 'STARTING')
        ) {
          refusal = {
            code: 'CAMPAIGN_NOT_ACTIVE',
            message: `The campaign is ${current?.state ?? 'gone'} and starts no attempt`,
          };
          return refusal.message;
        }
        const fresh = await decideGate(
          tx as unknown as PrismaClient,
          campaign,
          target.id,
          hasCheck
        );
        if (fresh) {
          refusal = { code: fresh.code, message: fresh.message };
          return refusal.message;
        }
        const latest = await tx.campaignAttempt.aggregate({
          _max: { n: true },
          where: { targetId: target.id },
        });
        if ((latest._max.n ?? 0) !== priorN) {
          refusal = {
            code: 'TARGET_NOT_STARTABLE',
            message: 'The target was started by another call; try again',
          };
          return refusal.message;
        }
        return null;
      },
      inTransaction: async (tx) => {
        const row = await tx.campaignAttempt.create({
          data: { childWorkflowId, n, startedAt: new Date(), targetId: target.id },
        });
        attemptId = row.id;
        const now = new Date();
        await runUnscoped(
          'the target is written by its own id and team under the campaign lock',
          ['CampaignTarget'],
          () =>
            tx.campaignTarget.updateMany({
              data: { failureReason: null, finishedAt: null, startedAt: now, state: 'RUNNING' },
              where: {
                id: target.id,
                state: { in: ['PENDING', 'BLOCKED'] },
                teamId: target.teamId,
              },
            })
        );
      },
      log: c.log,
      sourceAuthorization: { actor },
    }
  );
  if (!launch.ok) {
    if (launch.reason === 'GUARD_REFUSED') {
      const r = refusal as { code: CampaignRefusalCode; message: string } | null;
      return r
        ? refuse(r.code, r.message)
        : refuse('TARGET_NOT_STARTABLE', 'The attempt could not be started');
    }
    // The ledger's unique rows decided a race: a retried call, or two calls for one attempt.
    if (launcherId) {
      const replay = await findReplay(c, launcherId);
      if (replay) {
        return { data: replay, ok: true, status: 200 };
      }
    }
    return refuse('TARGET_NOT_STARTABLE', 'The target was started by another call; try again');
  }

  try {
    await writeAuditLog(fastify, {
      action: 'UPDATE',
      actor: null,
      after: {
        attempt: n,
        branch,
        state: 'RUNNING',
        targetId: target.id,
        workflowId: childWorkflowId,
      },
      before: { state: previousState, targetId: target.id },
      entityId: campaign.id,
      entityType: 'Campaign',
    });
  } catch (err) {
    c.log.error(
      { campaignId: campaign.id, err },
      'campaign attempt audit write failed — it started'
    );
  }
  return {
    data: { attemptId, branch, n, runId: null, workflowId: childWorkflowId },
    ok: true,
    status: 201,
  };
}

async function resolveBudget(
  prisma: PrismaClient,
  campaignId: string
): Promise<{ exceeded: boolean; cap: number | null }> {
  const row = await prisma.campaign.findFirst({
    select: { budgetUsd: true },
    where: { id: campaignId },
  });
  const cap = row?.budgetUsd == null ? null : Number(row.budgetUsd);
  if (cap === null) {
    return { cap, exceeded: false };
  }
  return { cap, exceeded: (await campaignMonthSpendUsd(prisma, campaignId)) >= cap };
}

/** Pause the campaign at its budget: the row first, as every control action does. */
async function pauseForBudget(
  c: AttemptContext,
  campaign: { id: string; ownerTeamId: string }
): Promise<void> {
  const moved = await c.fastify.prisma.campaign.updateMany({
    data: { pausedReason: 'budget', state: 'PAUSED' },
    where: {
      id: campaign.id,
      ownerTeamId: campaign.ownerTeamId,
      state: { in: ['ACTIVE', 'STARTING'] },
    },
  });
  if (moved.count > 0) {
    await writeAuditLog(c.fastify, {
      action: 'UPDATE',
      actor: null,
      after: { pausedReason: 'budget', state: 'PAUSED' },
      before: { state: 'ACTIVE' },
      entityId: campaign.id,
      entityType: 'Campaign',
    }).catch((err: unknown) =>
      c.log.error({ campaignId: campaign.id, err }, 'budget pause audit failed')
    );
  }
}

/**
 * Step 4: whether the gate and both limits let this one target start now. Reads every target of
 * the campaign; `decideSchedule` is given only this target among the ones waiting to start (plus
 * every target it transitively waits for), so a sibling that sorts earlier cannot be read as
 * holding a slot the worker has not asked it to take.
 */
async function decideGate(
  prisma: PrismaClient,
  campaign: {
    id: string;
    gate: string;
    maxOpenPullRequests: number | null;
    maxParallel: number;
  },
  targetId: string,
  hasCheck: boolean
): Promise<ReturnType<typeof refuse> | null> {
  const rows = await runUnscoped(
    'the gate decision reads every target of the campaign being started; no identity leaves this function',
    ['CampaignTarget'],
    () =>
      prisma.campaignTarget.findMany({
        select: { dependsOn: true, id: true, position: true, repoLabel: true, state: true },
        where: { campaignId: campaign.id },
      })
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const upstream = new Set<string>();
  const stack = [...(byId.get(targetId)?.dependsOn ?? [])];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (upstream.has(id) || id === targetId) {
      continue;
    }
    upstream.add(id);
    stack.push(...(byId.get(id)?.dependsOn ?? []));
  }
  const waiting = (state: string) => state === 'PENDING' || state === 'BLOCKED';
  const considered = rows.filter(
    (r) => r.id === targetId || upstream.has(r.id) || !waiting(r.state)
  );
  const decision = decideSchedule({
    campaignState: 'ACTIVE',
    gate: campaign.gate as CampaignGateValue,
    hasCheck,
    maxOpenPullRequests: campaign.maxOpenPullRequests,
    maxParallel: campaign.maxParallel,
    targets: considered.map((r) => ({
      dependsOn: r.dependsOn,
      id: r.id,
      label: r.repoLabel,
      position: r.position,
      state: r.state as TargetState,
    })),
  });
  if (decision.start.includes(targetId)) {
    return null;
  }
  const blocked = decision.blocked.find((b) => b.targetId === targetId);
  if (!blocked) {
    return refuse('TARGET_NOT_STARTABLE', 'The target is not waiting to start');
  }
  const text = describeBlockReason(blocked.reason);
  switch (blocked.reason.kind) {
    case 'max-parallel':
      return refuse('MAX_PARALLEL', text);
    case 'max-open-pull-requests':
      return refuse('MAX_OPEN_PULL_REQUESTS', text);
    default:
      return refuse('GATE_CLOSED', text);
  }
}
