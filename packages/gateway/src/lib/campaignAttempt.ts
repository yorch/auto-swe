import type { Prisma, PrismaClient } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import type {
  CampaignRefusalCode,
  CampaignStartAttemptResponse,
} from '@auto-swe/shared/lib/campaignApi';
import { recipeSupportsCheck } from '@auto-swe/shared/lib/campaignRecipes';
import { campaignMonthStart, campaignSpendUsd } from '@auto-swe/shared/lib/campaignSpend';
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
import {
  BUDGET_TIERS,
  type BudgetTier,
  type RepoWorkRequest,
} from '@auto-swe/shared/types/workflow';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { getErrorName } from '../plugins/auth.js';
import { resolveDefaultTemplate } from '../routes/workRequests.js';
import { writeAuditLog } from './auditLog.js';
import { checkLauncherAvailable, decideTargetLaunch, loadLaunchRepos } from './campaignAccess.js';
import { checkPushPermission } from './orchestrationAccess.js';
import { isTerminalSignalError } from './temporalErrors.js';
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

/** What an earlier call with this key wrote: enough to answer it again, and to start its run. */
interface PriorAttempt {
  attemptId: string;
  branch: string | null;
  connectionId: string | null;
  description: string;
  n: number;
  payload: Record<string, unknown> | null;
  repoId: string | null;
  requestPayload: string;
  runId: string | null;
  targetId: string;
  templateId: string | null;
  templateVersion: number | null;
  workflowId: string;
  workRequestId: string;
}

/** The attempt a call with this key already wrote the ledger for, if any. */
async function findPrior(c: AttemptContext, launcherId: string): Promise<PriorAttempt | null> {
  const key = idempotencyColumn(c);
  if (!key) {
    return null;
  }
  const prior = await c.fastify.prisma.runInput.findFirst({
    select: {
      activeWorkflows: { select: { assignedBranch: true, repoId: true, temporalWorkflowId: true } },
      connectionId: true,
      description: true,
      id: true,
      payload: true,
      requestPayload: true,
      templateId: true,
      templateVersion: true,
    },
    where: { idempotencyKey: key, requestedById: launcherId },
  });
  const wf = prior?.activeWorkflows[0];
  if (!prior || !wf) {
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
        connectionId: prior.connectionId,
        description: prior.description,
        n: attempt.n,
        payload: (prior.payload ?? null) as Record<string, unknown> | null,
        repoId: wf.repoId,
        requestPayload: prior.requestPayload,
        runId: attempt.runId,
        targetId: c.targetId,
        templateId: prior.templateId,
        templateVersion: prior.templateVersion,
        workflowId: wf.temporalWorkflowId,
        workRequestId: prior.id,
      }
    : null;
}

const replayData = (p: PriorAttempt): CampaignStartAttemptResponse => ({
  attemptId: p.attemptId,
  branch: p.branch,
  n: p.n,
  runId: p.runId,
  workflowId: p.workflowId,
});

/** The request a child run starts with: one builder, so a replay starts what the first call would have. */
function buildAttemptRequest(a: {
  branch: string;
  connectionId: string;
  description: string;
  launcherId: string;
  n: number;
  parentWorkflowId: string;
  payload: Record<string, unknown> | null;
  requestPayload: string;
  ticket: string;
  tier: BudgetTier | undefined;
  workRequestId: string;
}): RepoWorkRequest {
  return {
    ...(a.n > 1 ? { branchName: a.branch } : {}),
    ...(a.tier ? { budgetTier: a.tier } : {}),
    connectionId: a.connectionId,
    description: a.description,
    externalTicketId: a.ticket,
    launchedById: a.launcherId,
    parentWorkflowId: a.parentWorkflowId,
    ...(a.payload ? { payload: a.payload } : {}),
    repoId: a.connectionId,
    requestPayload: a.requestPayload,
    workRequestId: a.workRequestId,
  };
}

const GRPC_DEFINITE_REFUSALS = new Set([
  3, // INVALID_ARGUMENT
  5, // NOT_FOUND (the namespace)
  7, // PERMISSION_DENIED
  8, // RESOURCE_EXHAUSTED
  9, // FAILED_PRECONDITION
  12, // UNIMPLEMENTED
  16, // UNAUTHENTICATED
]);

/**
 * Whether a failed start DEFINITELY started nothing: the client refused the call before any RPC
 * (a value or payload it cannot encode), the server answered with a gRPC status that rejects the
 * request outright, or the TCP connection was refused. Everything else (a timeout, a deadline, a
 * reset, `UNAVAILABLE`, an error nobody recognises) may have reached the server before it failed,
 * and is ambiguous: the execution may exist.
 */
export function isDefiniteNonStart(err: unknown): boolean {
  const name = getErrorName(err);
  if (name === 'ValueError' || name === 'PayloadConverterError' || name === 'TypeError') {
    return true;
  }
  const cause = (err as { cause?: unknown } | null)?.cause as
    | { code?: unknown; name?: string }
    | undefined;
  const code = (err as { code?: unknown } | null)?.code ?? cause?.code;
  if (code === 'ECONNREFUSED') {
    return true;
  }
  return name === 'ServiceError' && typeof cause?.code === 'number'
    ? GRPC_DEFINITE_REFUSALS.has(cause.code)
    : false;
}

/**
 * A campaign being cancelled stops every run it started: a cancel that landed between the ledger
 * commit and the start has already looked for this attempt's run and found none. Cancels the run
 * through the run cancel path and closes the attempt and its target, so no child outlives a
 * cancelled campaign. Returns whether it did.
 */
async function cancelIfCampaignClosing(
  c: AttemptContext,
  campaign: { id: string; ownerTeamId: string },
  run: { attemptId: string; workflowId: string; targetId: string; teamId: string }
): Promise<boolean> {
  const prisma = c.fastify.prisma;
  const now = await prisma.campaign.findFirst({
    select: { state: true },
    where: { id: campaign.id, ownerTeamId: campaign.ownerTeamId },
  });
  if (!now || (now.state !== 'CANCELLING' && now.state !== 'CANCELLED')) {
    return false;
  }
  try {
    await c.fastify.temporal.cancelWorkflow(run.workflowId);
  } catch (err) {
    // A run Temporal no longer has is already stopped; anything else asks for a retry, which
    // finds this ledger and cancels again.
    if (!isTerminalSignalError(err)) {
      throw err;
    }
  }
  const finishedAt = new Date();
  await prisma.campaignAttempt.updateMany({
    data: { finishedAt, outcome: 'CANCELLED' },
    where: { finishedAt: null, id: run.attemptId },
  });
  await runUnscoped(
    'closing the target of the attempt cancelled with its campaign, by its own id and team',
    ['CampaignTarget'],
    () =>
      prisma.campaignTarget.updateMany({
        data: { finishedAt, state: 'CANCELLED' },
        where: { id: run.targetId, state: 'RUNNING', teamId: run.teamId },
      })
  );
  return true;
}

const CAMPAIGN_CLOSING = (state: string) =>
  `The campaign is ${state}; the attempt that was starting was cancelled`;

/**
 * A retried call with a key whose first call wrote the ledger. The first call may have died after
 * the ledger commit and before (or during) the start, so the run is asked for, not assumed: found
 * means the first call's start landed; not found means it never did, and it is started now with the
 * same ids and the same work request.
 */
async function answerReplay(
  c: AttemptContext,
  campaign: {
    id: string;
    ownerTeamId: string;
    temporalWorkflowId: string;
    workRequestId: string;
  },
  launcherId: string,
  teamId: string
): Promise<AttemptResult | null> {
  const prior = await findPrior(c, launcherId);
  if (!prior) {
    return null;
  }
  const run = {
    attemptId: prior.attemptId,
    targetId: prior.targetId,
    teamId,
    workflowId: prior.workflowId,
  };
  const exists = await c.fastify.temporal.workflowExecutionExists(prior.workflowId);
  if (!exists) {
    const now = await c.fastify.prisma.campaign.findFirst({
      select: { state: true },
      where: { id: campaign.id, ownerTeamId: campaign.ownerTeamId },
    });
    if (now?.state === 'CANCELLING' || now?.state === 'CANCELLED') {
      // Nothing started and nothing will: close what the first call wrote.
      await closeUnstartedAttempt(c, run);
      return refuse('CAMPAIGN_NOT_ACTIVE', CAMPAIGN_CLOSING(now.state));
    }
    if (!prior.connectionId || !prior.templateId || prior.templateVersion === null) {
      return refuse('TARGET_UNAVAILABLE', 'The attempt’s repository or template is not recorded');
    }
    const tier = await launchedBudgetTier(c.fastify.prisma, campaign.workRequestId);
    try {
      await c.fastify.temporal.startRunnableWorkflow(
        prior.workflowId,
        {
          request: buildAttemptRequest({
            branch: prior.branch ?? '',
            connectionId: prior.connectionId,
            description: prior.description,
            launcherId,
            n: prior.n,
            parentWorkflowId: campaign.temporalWorkflowId,
            payload: prior.payload,
            requestPayload: prior.requestPayload,
            ticket: campaignTicketId(campaign.id),
            tier,
            workRequestId: prior.workRequestId,
          }),
          templateId: prior.templateId,
          templateVersion: prior.templateVersion,
        },
        { rejectReuse: true }
      );
    } catch (err) {
      // An execution of this id appeared (another retry started it): adopt it. Any other failure
      // is answered as one, with the ledger kept, so the next retry decides again.
      if (getErrorName(err) !== 'WorkflowExecutionAlreadyStartedError') {
        throw err;
      }
    }
  }
  if (await cancelIfCampaignClosing(c, campaign, run)) {
    return refuse('CAMPAIGN_NOT_ACTIVE', CAMPAIGN_CLOSING('being cancelled'));
  }
  return { data: replayData(prior), ok: true, status: 200 };
}

/** Close an attempt whose run was never started, with its target, as cancelled. */
async function closeUnstartedAttempt(
  c: AttemptContext,
  run: { attemptId: string; targetId: string; teamId: string }
): Promise<void> {
  const finishedAt = new Date();
  await c.fastify.prisma.campaignAttempt.updateMany({
    data: { finishedAt, outcome: 'CANCELLED' },
    where: { finishedAt: null, id: run.attemptId },
  });
  await runUnscoped(
    'closing the target of an attempt that never started, by its own id and team',
    ['CampaignTarget'],
    () =>
      c.fastify.prisma.campaignTarget.updateMany({
        data: { finishedAt, state: 'CANCELLED' },
        where: { id: run.targetId, state: 'RUNNING', teamId: run.teamId },
      })
  );
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

/** Thrown inside the ledger transaction to roll it back with a coded refusal. */
export class AttemptRollback extends Error {
  constructor(
    readonly code: CampaignRefusalCode,
    message: string
  ) {
    super(message);
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
    const replay = await answerReplay(c, campaign, launcherId, target.teamId);
    if (replay) {
      return replay;
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
  const availability = await checkLauncherAvailable(prisma, {
    launchedById: launcherId,
    orgId: campaign.orgId,
    ownerTeamId: campaign.ownerTeamId,
  });
  if (!availability.ok) {
    return refuse('LAUNCHER_UNAVAILABLE', availability.message);
  }
  const { actor } = availability;
  const launcher = { id: actor.sub };

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
  const request = buildAttemptRequest({
    branch,
    connectionId: target.connectionId,
    description,
    launcherId: launcher.id,
    n,
    parentWorkflowId: campaign.temporalWorkflowId,
    payload,
    requestPayload,
    ticket,
    tier,
    workRequestId,
  });

  let refusal: { code: CampaignRefusalCode; message: string } | null = null;
  let attemptId = '';
  const previousState = target.state;
  let launch: Awaited<ReturnType<typeof launchTrackedWorkflow>>;
  const lockCtx: AttemptLockContext = {
    campaign,
    hasCheck,
    launcherId,
    priorN,
    targetId: target.id,
  };
  try {
    launch = await launchTrackedWorkflow(
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
          // The attempt's id names this attempt for good: a closed execution under it is refused
          // too, never read as room for a second run.
          await fastify.temporal.startRunnableWorkflow(
            childWorkflowId,
            { request, templateId, templateVersion },
            { rejectReuse: true }
          );
        } catch (err) {
          // An execution of this very id exists: a start whose reply was lost (the child did start
          // and the call errored). Adopt it, keeping the attempt row and the target's RUNNING state.
          if (getErrorName(err) === 'WorkflowExecutionAlreadyStartedError') {
            return;
          }
          if (!isDefiniteNonStart(err)) {
            // The call failed but the execution may exist. Nothing is undone: the rows a retry
            // with the same key finds decide it (`answerReplay`: found is adopted, not found is
            // started with this very work request).
            throw err;
          }
          // The run definitely did not start: the attempt and the target's state go back as they
          // were, and the ledger is compensated, so the worker's retry starts a clean one.
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
          refusal = await checkAttemptUnderLock(tx, lockCtx);
          return refusal?.message ?? null;
        },
        inTransaction: async (tx) => {
          attemptId = await writeAttemptRows(tx, {
            childWorkflowId,
            n,
            targetId: target.id,
            teamId: target.teamId,
          });
        },
        log: c.log,
        retainLedgerOnStartError: (err) =>
          getErrorName(err) !== 'WorkflowExecutionAlreadyStartedError' && !isDefiniteNonStart(err),
        sourceAuthorization: { actor },
      }
    );
  } catch (err) {
    if (err instanceof AttemptRollback) {
      return refuse(err.code, err.message);
    }
    throw err;
  }
  if (!launch.ok) {
    if (launch.reason === 'GUARD_REFUSED') {
      const r = refusal as { code: CampaignRefusalCode; message: string } | null;
      return r
        ? refuse(r.code, r.message)
        : refuse('TARGET_NOT_STARTABLE', 'The attempt could not be started');
    }
    // The ledger's unique rows decided a race: a retried call, or two calls for one attempt.
    if (launcherId) {
      const replay = await answerReplay(c, campaign, launcherId, target.teamId);
      if (replay) {
        return replay;
      }
    }
    return refuse('TARGET_NOT_STARTABLE', 'The target was started by another call; try again');
  }

  // A cancel that landed between the ledger commit and the start looked for this run and found
  // none: the child would run on in a cancelled campaign. Ask again now that it exists.
  if (
    await cancelIfCampaignClosing(c, campaign, {
      attemptId,
      targetId: target.id,
      teamId: target.teamId,
      workflowId: childWorkflowId,
    })
  ) {
    return refuse('CAMPAIGN_NOT_ACTIVE', CAMPAIGN_CLOSING('being cancelled'));
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

/** What the locked decision of an attempt start reads. */
export interface AttemptLockContext {
  campaign: {
    id: string;
    gate: string;
    maxOpenPullRequests: number | null;
    maxParallel: number;
  };
  hasCheck: boolean;
  /** The launcher the checks ran for; a take-over since then refuses the start. */
  launcherId: string | null;
  /** The target's highest attempt number when the checks ran. */
  priorN: number;
  targetId: string;
}

/**
 * Step 4 and the checks that must hold at the moment the ledger is written, under the campaign's
 * row lock (the launch guard). Exported so the database-backed suite runs this very function
 * against Postgres, not a copy of it.
 *
 * Returns the refusal, or null to let the start proceed.
 */
export async function checkAttemptUnderLock(
  tx: Prisma.TransactionClient,
  ctx: AttemptLockContext
): Promise<{ code: CampaignRefusalCode; message: string } | null> {
  const { campaign } = ctx;
  // CLAUDE.md §7 exception: Prisma cannot express SELECT … FOR UPDATE. The campaign row is the
  // serialization point for the gate and both limits, so two concurrent starts cannot pass
  // the same one. It is taken before any other lock of the launch and no transaction takes it
  // after another, so it adds no edge to the lock order (`lockOrder.ts`).
  await tx.$queryRaw`SELECT id FROM campaigns WHERE id = ${campaign.id}::uuid FOR UPDATE`;
  const current = await tx.campaign.findFirst({
    select: { launchedById: true, state: true, workflowKind: true },
    where: { id: campaign.id },
  });
  if (
    current?.workflowKind !== 'RECONCILER' ||
    (current.state !== 'ACTIVE' && current.state !== 'STARTING')
  ) {
    return {
      code: 'CAMPAIGN_NOT_ACTIVE',
      message: `The campaign is ${current?.state ?? 'gone'} and starts no attempt`,
    };
  }
  // A take-over that landed since the checks ran: they ran for another launcher.
  if (current.launchedById !== ctx.launcherId) {
    return {
      code: 'LAUNCHER_UNAVAILABLE',
      message: 'The campaign’s launcher changed while the attempt was starting; try again',
    };
  }
  // The target as it is under the lock: a remove or cancel that committed since the unlocked
  // read leaves nothing to start.
  const lockedTarget = await runUnscoped(
    'the target is re-read by its own id under the campaign lock',
    ['CampaignTarget'],
    () =>
      tx.campaignTarget.findFirst({
        select: { state: true },
        where: { campaignId: campaign.id, id: ctx.targetId },
      })
  );
  if (
    !lockedTarget ||
    !STARTABLE.includes(normalizeTargetState(lockedTarget.state as TargetState))
  ) {
    return {
      code: 'TARGET_NOT_STARTABLE',
      message: `The target is ${lockedTarget?.state ?? 'gone'}, not waiting to start`,
    };
  }
  const fresh = await decideGate(
    tx as unknown as PrismaClient,
    campaign,
    ctx.targetId,
    ctx.hasCheck
  );
  if (fresh) {
    return { code: fresh.code, message: fresh.message };
  }
  const latest = await tx.campaignAttempt.aggregate({
    _max: { n: true },
    where: { targetId: ctx.targetId },
  });
  if ((latest._max.n ?? 0) !== ctx.priorN) {
    return {
      code: 'TARGET_NOT_STARTABLE',
      message: 'The target was started by another call; try again',
    };
  }
  return null;
}

/**
 * The attempt's rows, written in the ledger transaction after `checkAttemptUnderLock`. The target
 * moves to `RUNNING` first, conditionally: when it is no longer startable the whole transaction
 * rolls back (`AttemptRollback`), so no attempt, run input or active workflow outlives a target
 * that was removed. Returns the new attempt's id.
 */
export async function writeAttemptRows(
  tx: Prisma.TransactionClient,
  row: { childWorkflowId: string; n: number; targetId: string; teamId: string }
): Promise<string> {
  const now = new Date();
  const moved = await runUnscoped(
    'the target is written by its own id and team under the campaign lock',
    ['CampaignTarget'],
    () =>
      tx.campaignTarget.updateMany({
        data: { failureReason: null, finishedAt: null, startedAt: now, state: 'RUNNING' },
        where: {
          id: row.targetId,
          state: { in: ['PENDING', 'BLOCKED'] },
          teamId: row.teamId,
        },
      })
  );
  if (moved.count !== 1) {
    throw new AttemptRollback(
      'TARGET_NOT_STARTABLE',
      'The target changed while the attempt was starting; try again'
    );
  }
  const created = await tx.campaignAttempt.create({
    data: {
      childWorkflowId: row.childWorkflowId,
      n: row.n,
      startedAt: now,
      targetId: row.targetId,
    },
  });
  return created.id;
}

async function resolveBudget(
  prisma: PrismaClient,
  campaignId: string
): Promise<{ exceeded: boolean; cap: number | null }> {
  const row = await prisma.campaign.findFirst({
    select: { budgetUsd: true, orgId: true },
    where: { id: campaignId },
  });
  const cap = row?.budgetUsd == null ? null : Number(row.budgetUsd);
  if (cap === null || !row) {
    return { cap, exceeded: false };
  }
  const spent = await campaignSpendUsd(prisma, {
    campaignId,
    monthStart: campaignMonthStart(new Date()),
    orgId: row.orgId,
  });
  return { cap, exceeded: spent >= cap };
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
