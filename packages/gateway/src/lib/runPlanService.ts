import crypto from 'node:crypto';
import { Role } from '@auto-swe/shared';
import { resolveSettings, roleMeets, snapshotPinnedSettings } from '@auto-swe/shared/config';
import { AGENT_RUN_TEMPLATE_NAME, AGENT_RUN_TEMPLATE_ORIGIN } from '@auto-swe/shared/lib/agentRun';
import {
  closeAgentRunLedgerRows,
  loadAgentRunSlots,
  reconcileAgentRunSlots,
  wouldAdmitNewRun,
} from '@auto-swe/shared/lib/agentRunAdmission';
import { repositoryHostsAllowed } from '@auto-swe/shared/lib/connectionCredential';
import { isGitRepoConnection } from '@auto-swe/shared/lib/connectionGuards';
import {
  PLANNED_RUN_TEMPLATE_NAME,
  PLANNED_RUN_TEMPLATE_ORIGIN,
  PlannedRunPayloadSchema,
  plannedRunTicketId,
  RUN_PLAN_MODES,
  type RunPlanMode,
} from '@auto-swe/shared/lib/plannedRun';
import type { RepoAccessGate } from '@auto-swe/shared/lib/repoAccessGate';
import {
  agentPinDrift,
  type RunPlanAgentPins,
  resolveRunPlanAgentPins,
  specAgentKeys,
} from '@auto-swe/shared/lib/runPlanAgentPins';
import { stableStringify } from '@auto-swe/shared/lib/stableJson';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { generateBranchName } from '@auto-swe/shared/lib/workflowId';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import {
  migrateSpec,
  parseWorkflowSpec,
  SPEC_SCHEMA_VERSION,
  validateSpec,
  type WorkflowSpec,
} from '@auto-swe/shared/workflow';
import {
  checkSkeletonPolicy,
  hashRunPlanSpec,
  runPlanCatalogHash,
} from '@auto-swe/shared/workflow/runPlan';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';
import { validateRunConnection } from './runConnection.js';
import { runProvenance } from './runProvenance.js';
import { launchTrackedWorkflow } from './workflowLaunch.js';

/**
 * The service layer of run plans (docs/specs/2026-11-17-launch-time-workflow-generation.md): create
 * a plan record, approve it, reject it, launch an approved one, and expire the stale ones. No
 * HTTP here; the routes that call it come later and add the `assistantPolicy` entries.
 *
 * Three rules shape every function:
 *
 * - **A plan belongs to one human.** The owner is a `User` row, never a service principal, and is
 *   the only one who may approve, reject or launch it. A caller who is not the owner is answered
 *   exactly as for a plan that does not exist.
 * - **A refusal never repairs.** An approval that finds the plan changed (its spec, its agents, the
 *   settings it was built under, the policy it must meet, the repository's reach) refuses and
 *   leaves the plan as it was. Nothing here regenerates or edits a spec.
 * - **A transition is an `updateMany` with the expected status in its `where`.** Two simultaneous
 *   approvals cannot both match; the loser is told the plan is no longer pending.
 *
 * The worker repeats the checks that matter when it creates the run (`createWorkflowRun`): this
 * layer exists for good errors and to stop a doomed launch early, not to be the authority.
 */

/** How long a plan may sit unapproved before it expires. */
export const DEFAULT_PLAN_TTL_MS = 30 * 60_000;
/** How long an expired or rejected plan is kept before the sweeper deletes it. */
export const DEFAULT_PLAN_RETENTION_MS = 7 * 24 * 3_600_000;

export interface PlanRefusal {
  ok: false;
  status: number;
  code: string;
  message: string;
}

const refuse = (status: number, code: string, message: string): PlanRefusal => ({
  code,
  message,
  ok: false,
  status,
});

/** A plan a caller may not see or act on: no hint whether it exists. */
const NOT_FOUND = refuse(404, 'PLAN_NOT_FOUND', 'Plan not found');

/** The person acting. `role` is read again from the database; the token's copy is not trusted. */
export interface PlanActor {
  sub: string;
}

/**
 * Per-user limits (plans per hour, pending plans). Settings and the counts behind them arrive with
 * the routes; the service only asks. Return a refusal to stop the action, or `null` to allow it.
 */
export interface RunPlanQuotaPolicy {
  checkCreate(ctx: { userId: string; teamId: string }): Promise<PlanRefusal | null>;
  checkApprove(ctx: {
    userId: string;
    teamId: string;
    planId: string;
  }): Promise<PlanRefusal | null>;
}

export const NO_PLAN_QUOTAS: RunPlanQuotaPolicy = {
  checkApprove: async () => null,
  checkCreate: async () => null,
};

export interface RunPlanServiceDeps {
  prisma: FastifyInstance['prisma'];
  /** The GitHub permission gate (`request.repoAccessGate`); undefined means no gate. */
  gate?: RepoAccessGate | undefined;
  log?: FastifyBaseLogger | undefined;
  now?: () => Date;
  quotas?: RunPlanQuotaPolicy;
}

export interface RunPlanLaunchDeps extends RunPlanServiceDeps {
  temporal: Pick<FastifyInstance['temporal'], 'startRunnableWorkflow' | 'isWorkflowGone'>;
}

const nowOf = (deps: RunPlanServiceDeps): Date => (deps.now ?? (() => new Date()))();

/** Capture what `validateRunConnection` would have sent, so its decision can be returned. */
function captureReply(): { reply: FastifyReply; refusal: () => PlanRefusal } {
  let status = 500;
  let body: unknown;
  const reply = {
    send(b: unknown) {
      body = b;
      return reply;
    },
    status(code: number) {
      status = code;
      return reply;
    },
  };
  return {
    refusal: () => {
      const error = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
      return refuse(
        status,
        error?.code ?? 'LAUNCH_REFUSED',
        error?.message ?? 'The repository cannot be used for this plan'
      );
    },
    reply: reply as unknown as FastifyReply,
  };
}

/** The user row behind an actor: active and at least an ENGINEER. */
async function requireEngineer(
  deps: RunPlanServiceDeps,
  actor: PlanActor
): Promise<{ ok: true; role: Role } | PlanRefusal> {
  const user = await deps.prisma.user.findUnique({
    select: { id: true, isActive: true, role: true },
    where: { id: actor.sub },
  });
  if (!user?.isActive) {
    return refuse(403, 'FORBIDDEN', 'Only an active user can use run plans');
  }
  if (!roleMeets(user.role as Role, Role.ENGINEER)) {
    return refuse(403, 'FORBIDDEN', 'Run plans need the ENGINEER role');
  }
  return { ok: true, role: user.role as Role };
}

function parseStoredSpec(raw: unknown): WorkflowSpec | null {
  try {
    return parseWorkflowSpec(migrateSpec(raw, SPEC_SCHEMA_VERSION));
  } catch {
    return null;
  }
}

function isMode(value: unknown): value is RunPlanMode {
  return typeof value === 'string' && (RUN_PLAN_MODES as readonly string[]).includes(value);
}

/**
 * What a plan's settings snapshot is: the run-pinned registry settings, resolved for the
 * repository's team and organization and the Planned Run template. The generator and every
 * approval must use this one function, so the two sides cannot disagree about scope.
 */
export async function snapshotPlanSettings(scope: {
  teamId: string;
  orgId: string | null;
  plannedRunTemplateId: string;
}): Promise<Record<string, unknown>> {
  return snapshotPinnedSettings({
    ...(scope.orgId ? { orgId: scope.orgId } : {}),
    teamId: scope.teamId,
    workflowTemplateId: scope.plannedRunTemplateId,
  });
}

/** The Planned Run template, by its reserved origin and name. */
export async function loadPlannedRunTemplate(deps: Pick<RunPlanServiceDeps, 'prisma'>) {
  return deps.prisma.workflowTemplate.findFirst({
    select: { activeVersion: true, id: true },
    where: {
      name: PLANNED_RUN_TEMPLATE_NAME,
      origin: PLANNED_RUN_TEMPLATE_ORIGIN,
      status: 'ACTIVE',
      teamId: null,
    },
  });
}

/** The repository, reachable by the actor and fit for a plan: the launch decision, reused. */
async function authorizeRepository(
  deps: RunPlanServiceDeps,
  actor: PlanActor,
  connectionId: string
): Promise<
  | {
      ok: true;
      repo: { id: string; teamId: string; orgId: string | null };
    }
  | PlanRefusal
> {
  const captured = captureReply();
  const decision = await validateRunConnection(
    {
      connectionId,
      gate: deps.gate,
      log: deps.log,
      prisma: deps.prisma,
      providerMeta: null,
      templateTeamId: null,
      user: { exp: 0, iat: 0, role: Role.ENGINEER, sub: actor.sub },
    },
    captured.reply
  );
  if (!decision.ok) {
    return captured.refusal();
  }
  const repo = await deps.prisma.connection.findUnique({
    select: {
      githubApiUrl: true,
      githubUrl: true,
      id: true,
      organizationName: true,
      repoName: true,
      team: { select: { orgId: true } },
      teamId: true,
      type: true,
    },
    where: { id: connectionId },
  });
  if (!repo) {
    return refuse(404, 'CONNECTION_NOT_FOUND', 'Connection not found or inactive');
  }
  if (!isGitRepoConnection(repo)) {
    return refuse(400, 'NOT_A_GIT_REPO', 'Run plans need a git repository');
  }
  const hosts = await repositoryHostsAllowed({
    githubApiUrl: repo.githubApiUrl,
    githubUrl: repo.githubUrl,
  });
  if (!hosts.ok) {
    return refuse(
      422,
      'REPO_HOST_NOT_ALLOWED',
      `This repository's host is not on the approved repository hosts (${hosts.url})`
    );
  }
  return { ok: true, repo: { id: repo.id, orgId: repo.team.orgId, teamId: repo.teamId } };
}

// ───────────────────────────── create ─────────────────────────────

export interface CreatePlanInput {
  owner: PlanActor;
  connectionId: string;
  /** The library agent a library-agent plan is built on; null for an engineering plan. */
  agentKey?: string | null;
  intent: string;
  routerCandidates: unknown;
  /** The generated spec. Parsed, checked and hashed here; the caller's reports are not trusted. */
  spec: unknown;
  mode: RunPlanMode;
  costEstimate: unknown;
  model: string;
  /** `resolveRunPlanAgentPins` output for every agent the plan relies on. */
  agentPins: RunPlanAgentPins;
  /** `snapshotPlanSettings` output at generation time. */
  settingsSnapshot: Record<string, unknown>;
  /** `runPlanCatalogHash()` at generation time. */
  catalogHash: string;
  ttlMs?: number;
}

export type CreatePlanResult = { ok: true; planId: string; expiresAt: Date } | PlanRefusal;

/**
 * Store a generated plan as PENDING. The owner must be an active ENGINEER who can reach the
 * repository; the spec must parse, pass the skeleton policy and `validateSpec` (a plan that fails
 * is never stored, so there is nothing to approve); its hash and both reports are computed here.
 */
export async function createPlanRecord(
  deps: RunPlanServiceDeps,
  input: CreatePlanInput
): Promise<CreatePlanResult> {
  const engineer = await requireEngineer(deps, input.owner);
  if (!engineer.ok) {
    return engineer;
  }
  if (!isMode(input.mode)) {
    return refuse(400, 'PLAN_MODE_INVALID', 'Unknown plan mode');
  }
  const repository = await authorizeRepository(deps, input.owner, input.connectionId);
  if (!repository.ok) {
    return repository;
  }
  const spec = parseStoredSpec(input.spec);
  if (!spec) {
    return refuse(422, 'PLAN_SPEC_INVALID', 'The generated spec does not parse');
  }
  const skeletonReport = checkSkeletonPolicy(spec, input.mode);
  if (!skeletonReport.ok) {
    return refuse(
      422,
      'PLAN_POLICY_FAILED',
      `The plan breaks the skeleton policy (${skeletonReport.errors.map((e) => e.code).join(', ')})`
    );
  }
  const validationReport = validateSpec(spec);
  if (validationReport.errors.length > 0) {
    return refuse(
      422,
      'PLAN_SPEC_INVALID',
      `The plan fails validation (${validationReport.errors.map((e) => e.code).join(', ')})`
    );
  }
  const quota = await (deps.quotas ?? NO_PLAN_QUOTAS).checkCreate({
    teamId: repository.repo.teamId,
    userId: input.owner.sub,
  });
  if (quota) {
    return quota;
  }

  const now = nowOf(deps);
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? DEFAULT_PLAN_TTL_MS));
  // Hash what will be stored, read back through JSON, so the stored column hashes the same.
  const stored = JSON.parse(JSON.stringify(spec)) as unknown;
  const row = await deps.prisma.runPlan.create({
    data: {
      agentKey: input.agentKey ?? null,
      agentPins: input.agentPins as object,
      catalogHash: input.catalogHash,
      connectionId: repository.repo.id,
      costEstimate: input.costEstimate as object,
      createdAt: now,
      expiresAt,
      intent: input.intent,
      mode: input.mode,
      model: input.model,
      ownerUserId: input.owner.sub,
      routerCandidates: input.routerCandidates as object,
      settingsSnapshot: input.settingsSnapshot as object,
      skeletonReport: JSON.parse(JSON.stringify(skeletonReport)) as object,
      spec: stored as object,
      specHash: hashRunPlanSpec(stored),
      status: 'PENDING',
      teamId: repository.repo.teamId,
      validationReport: JSON.parse(JSON.stringify(validationReport)) as object,
    },
    select: { expiresAt: true, id: true },
  });
  return { expiresAt: row.expiresAt, ok: true, planId: row.id };
}

// ───────────────────────────── approve ─────────────────────────────

type PlanRow = NonNullable<
  Awaited<ReturnType<RunPlanServiceDeps['prisma']['runPlan']['findUnique']>>
>;

export type ApprovePlanResult =
  | { ok: true; plan: PlanRow; repo: { id: string; teamId: string; orgId: string | null } }
  | PlanRefusal;

/** Everything approval re-checks, short of flipping the status. */
async function verifyPlanForApproval(
  deps: RunPlanServiceDeps,
  actor: PlanActor,
  planId: string
): Promise<ApprovePlanResult> {
  const plan = await deps.prisma.runPlan.findUnique({ where: { id: planId } });
  // A plan another person owns is answered as a plan that does not exist.
  if (!plan || plan.ownerUserId !== actor.sub) {
    return NOT_FOUND;
  }
  const now = nowOf(deps);
  if (plan.status !== 'PENDING') {
    return refuse(409, 'PLAN_NOT_PENDING', `The plan is ${plan.status}, not PENDING`);
  }
  if (plan.expiresAt.getTime() <= now.getTime()) {
    // Best effort: the sweeper would do it, and nothing depends on it.
    await deps.prisma.runPlan
      .updateMany({
        data: { status: 'EXPIRED' },
        where: { id: plan.id, status: 'PENDING', teamId: plan.teamId },
      })
      .catch(() => undefined);
    return refuse(409, 'PLAN_EXPIRED', 'The plan has expired; create a new one');
  }

  const engineer = await requireEngineer(deps, actor);
  if (!engineer.ok) {
    return engineer;
  }
  if (!isMode(plan.mode)) {
    return refuse(409, 'PLAN_MODE_INVALID', 'The plan has an unknown mode');
  }

  if (hashRunPlanSpec(plan.spec) !== plan.specHash) {
    return refuse(409, 'PLAN_TAMPERED', 'The stored plan no longer matches its recorded hash');
  }
  const spec = parseStoredSpec(plan.spec);
  if (!spec) {
    return refuse(409, 'PLAN_SPEC_INVALID', 'The stored spec does not parse');
  }
  const policy = checkSkeletonPolicy(spec, plan.mode);
  if (!policy.ok) {
    return refuse(
      409,
      'PLAN_POLICY_FAILED',
      `The plan no longer meets the skeleton policy (${policy.errors.map((e) => e.code).join(', ')})`
    );
  }
  const validation = validateSpec(spec);
  if (validation.errors.length > 0) {
    return refuse(
      409,
      'PLAN_SPEC_INVALID',
      `The plan no longer validates (${validation.errors.map((e) => e.code).join(', ')})`
    );
  }
  if (plan.catalogHash !== runPlanCatalogHash()) {
    return refuse(
      409,
      'PLAN_CATALOG_CHANGED',
      'The step catalog changed since the plan was made; create a new plan'
    );
  }

  // Reach is decided now, as for a fresh launch, not carried over from creation.
  const repository = await authorizeRepository(deps, actor, plan.connectionId);
  if (!repository.ok) {
    return repository;
  }
  if (repository.repo.teamId !== plan.teamId) {
    return refuse(
      409,
      'PLAN_REPOSITORY_CHANGED',
      'The repository changed teams since the plan was made; create a new plan'
    );
  }

  const named = specAgentKeys(spec);
  const recorded =
    plan.agentPins && typeof plan.agentPins === 'object' && !Array.isArray(plan.agentPins)
      ? Object.keys(plan.agentPins as Record<string, unknown>)
      : [];
  const current = await resolveRunPlanAgentPins(deps.prisma, [...recorded, ...named], {
    orgId: repository.repo.orgId,
    teamId: repository.repo.teamId,
  });
  const drift = agentPinDrift(plan.agentPins, current, named);
  if (drift.length > 0) {
    return refuse(
      409,
      'PLAN_AGENTS_CHANGED',
      `These agents changed since the plan was made: ${drift.join(', ')}. Create a new plan.`
    );
  }

  const template = await loadPlannedRunTemplate(deps);
  if (!template?.activeVersion) {
    return refuse(
      503,
      'PLANNED_RUN_TEMPLATE_MISSING',
      'The Planned Run system template is not installed; run the database seed'
    );
  }
  const settings = await snapshotPlanSettings({
    orgId: repository.repo.orgId,
    plannedRunTemplateId: template.id,
    teamId: repository.repo.teamId,
  });
  if (stableStringify(settings) !== stableStringify(plan.settingsSnapshot)) {
    return refuse(
      409,
      'PLAN_SETTINGS_CHANGED',
      'Settings the run depends on changed since the plan was made; create a new plan'
    );
  }

  const quota = await (deps.quotas ?? NO_PLAN_QUOTAS).checkApprove({
    planId: plan.id,
    teamId: plan.teamId,
    userId: actor.sub,
  });
  if (quota) {
    return quota;
  }
  return { ok: true, plan, repo: repository.repo };
}

/** The atomic PENDING -> APPROVED transition. `false`: someone else moved the plan first. */
async function flipToApproved(
  deps: RunPlanServiceDeps,
  plan: PlanRow,
  actor: PlanActor
): Promise<boolean> {
  const result = await deps.prisma.runPlan.updateMany({
    data: { approvedAt: nowOf(deps), approvedById: actor.sub, status: 'APPROVED' },
    where: {
      expiresAt: { gt: nowOf(deps) },
      id: plan.id,
      ownerUserId: actor.sub,
      status: 'PENDING',
      teamId: plan.teamId,
    },
  });
  return result.count === 1;
}

/**
 * Approve a plan: every re-check, then PENDING -> APPROVED. Does not start a run (see
 * {@link approveAndLaunchPlan} for the pair). A second approval of the same plan, or one that
 * races it, is refused with `PLAN_NOT_PENDING`.
 */
export async function approvePlan(
  deps: RunPlanServiceDeps,
  actor: PlanActor,
  planId: string
): Promise<ApprovePlanResult> {
  const verified = await verifyPlanForApproval(deps, actor, planId);
  if (!verified.ok) {
    return verified;
  }
  if (!(await flipToApproved(deps, verified.plan, actor))) {
    return refuse(409, 'PLAN_NOT_PENDING', 'The plan is no longer pending');
  }
  return verified;
}

// ───────────────────────────── reject / expire ─────────────────────────────

export type RejectPlanResult = { ok: true } | PlanRefusal;

/**
 * Reject a plan the caller owns. A PENDING plan, or an APPROVED one that has not been launched
 * (a launch that failed), can be rejected; a LAUNCHED plan has a run and cannot. If the worker is
 * claiming an APPROVED plan at this moment exactly one side wins: its claim then finds the plan
 * REJECTED and refuses.
 */
export async function rejectPlan(
  deps: RunPlanServiceDeps,
  actor: PlanActor,
  planId: string
): Promise<RejectPlanResult> {
  const plan = await deps.prisma.runPlan.findUnique({
    select: { id: true, ownerUserId: true, status: true, teamId: true },
    where: { id: planId },
  });
  if (!plan || plan.ownerUserId !== actor.sub) {
    return NOT_FOUND;
  }
  const result = await deps.prisma.runPlan.updateMany({
    data: { status: 'REJECTED' },
    where: {
      id: plan.id,
      ownerUserId: actor.sub,
      status: { in: ['PENDING', 'APPROVED'] },
      teamId: plan.teamId,
    },
  });
  if (result.count !== 1) {
    return refuse(409, 'PLAN_NOT_REJECTABLE', 'The plan can no longer be rejected');
  }
  return { ok: true };
}

export interface ExpirePlansResult {
  expired: number;
  deleted: number;
}

/**
 * The sweeper: PENDING and APPROVED-but-unlaunched plans past their expiry become EXPIRED, and
 * EXPIRED or REJECTED plans older than the retention window are deleted. Cross-tenant by nature,
 * so both writes are marked `runUnscoped`. LAUNCHED plans are never touched: a run names them.
 */
export async function expirePlans(
  deps: Pick<RunPlanServiceDeps, 'prisma' | 'now'>,
  opts: { retentionMs?: number } = {}
): Promise<ExpirePlansResult> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - (opts.retentionMs ?? DEFAULT_PLAN_RETENTION_MS));
  const expired = await runUnscoped(
    'the plan sweeper expires stale plans of every team',
    ['RunPlan'],
    () =>
      deps.prisma.runPlan.updateMany({
        data: { status: 'EXPIRED' },
        where: { expiresAt: { lte: now }, status: { in: ['PENDING', 'APPROVED'] } },
      })
  );
  const deleted = await runUnscoped(
    'the plan sweeper deletes old expired and rejected plans of every team',
    ['RunPlan'],
    () =>
      deps.prisma.runPlan.deleteMany({
        where: { createdAt: { lt: cutoff }, status: { in: ['EXPIRED', 'REJECTED'] } },
      })
  );
  return { deleted: deleted.count, expired: expired.count };
}

// ───────────────────────────── launch ─────────────────────────────

export type LaunchPlanResult =
  | {
      ok: true;
      planId: string;
      temporalWorkflowId: string;
      workRequestId: string;
      activeWorkflowId: string | null;
    }
  | PlanRefusal;

async function admitLibraryAgentPlan(
  deps: RunPlanLaunchDeps,
  repo: { orgId: string | null; teamId: string },
  plannedTemplateId: string
): Promise<PlanRefusal | null> {
  // A plan built on a library agent takes the same concurrency slots an agent run does.
  const settings = await resolveSettings(
    ['workspace.agentRunMaxConcurrentGlobal', 'workspace.agentRunMaxConcurrentPerTeam'],
    { ...(repo.orgId ? { orgId: repo.orgId } : {}), teamId: repo.teamId }
  );
  const agentRunTemplate = await deps.prisma.workflowTemplate.findFirst({
    select: { id: true },
    where: { name: AGENT_RUN_TEMPLATE_NAME, origin: AGENT_RUN_TEMPLATE_ORIGIN, teamId: null },
  });
  const slotTemplates = [plannedTemplateId, ...(agentRunTemplate ? [agentRunTemplate.id] : [])];
  const slots = (
    await Promise.all(
      slotTemplates.map(async (templateId) =>
        reconcileAgentRunSlots(await loadAgentRunSlots(deps.prisma, templateId), {
          close: closeAgentRunLedgerRows(deps.prisma),
          isRunning: async (workflowId) => !(await deps.temporal.isWorkflowGone(workflowId)),
          onClosed: (workflowIds) =>
            deps.log?.warn(
              { workflowIds },
              'closed run ledger rows whose workflow is no longer running'
            ),
          onUnreachable: (workflowId, err) =>
            deps.log?.warn(
              { err, workflowId },
              'could not confirm a run is finished; it keeps its concurrency slot'
            ),
        })
      )
    )
  ).flat();
  const admission = wouldAdmitNewRun(slots, repo.teamId, {
    global: settings['workspace.agentRunMaxConcurrentGlobal'],
    perTeam: settings['workspace.agentRunMaxConcurrentPerTeam'],
  });
  if (admission.admitted) {
    return null;
  }
  return admission.reason === 'disabled'
    ? refuse(403, 'AGENT_RUNS_DISABLED', 'Agent runs are disabled for this team')
    : refuse(
        429,
        'AGENT_RUN_CONCURRENCY_EXCEEDED',
        admission.reason === 'team_limit'
          ? "This team's agent runs are at their concurrency limit; try again when one finishes"
          : 'Agent runs are at the platform concurrency limit; try again when one finishes'
      );
}

/**
 * Start the run of an APPROVED plan through the tracked-launch path: ledger rows first, then the
 * workflow, rolled back if the start fails. The payload carries only the plan id; the worker loads
 * and pins the plan itself. The repository is authorized again and its host re-checked, the
 * launch guard re-asserts inside the ledger transaction that the plan is still APPROVED for this
 * person and unexpired, and a library-agent plan is admitted against agent-run concurrency.
 */
export async function launchApprovedPlan(
  deps: RunPlanLaunchDeps,
  actor: PlanActor,
  planId: string,
  opts: { budgetTier?: RepoWorkRequest['budgetTier'] } = {}
): Promise<LaunchPlanResult> {
  const plan = await deps.prisma.runPlan.findUnique({ where: { id: planId } });
  if (!plan || plan.ownerUserId !== actor.sub) {
    return NOT_FOUND;
  }
  if (plan.status !== 'APPROVED' || plan.approvedById !== actor.sub) {
    return refuse(409, 'PLAN_NOT_APPROVED', `The plan is ${plan.status}, not APPROVED`);
  }
  if (plan.expiresAt.getTime() <= nowOf(deps).getTime()) {
    return refuse(409, 'PLAN_EXPIRED', 'The plan has expired; create a new one');
  }
  const engineer = await requireEngineer(deps, actor);
  if (!engineer.ok) {
    return engineer;
  }
  const repository = await authorizeRepository(deps, actor, plan.connectionId);
  if (!repository.ok) {
    return repository;
  }
  if (repository.repo.teamId !== plan.teamId) {
    return refuse(409, 'PLAN_REPOSITORY_CHANGED', 'The repository changed teams since approval');
  }
  const template = await loadPlannedRunTemplate(deps);
  if (!template?.activeVersion) {
    return refuse(
      503,
      'PLANNED_RUN_TEMPLATE_MISSING',
      'The Planned Run system template is not installed; run the database seed'
    );
  }
  if (plan.agentKey) {
    const admitted = await admitLibraryAgentPlan(deps, repository.repo, template.id);
    if (admitted) {
      return admitted;
    }
  }

  const payload = PlannedRunPayloadSchema.parse({ planId: plan.id });
  const workRequestId = crypto.randomUUID();
  const externalTicketId = plannedRunTicketId(plan.id);
  const temporalWorkflowId = `plan-${plan.id.replace(/-/g, '').slice(0, 8)}-${crypto
    .randomUUID()
    .replace(/-/g, '')
    .slice(0, 16)}`;
  const { branchPrefix } = await resolveWorkflowDefaults();
  const budgetTier = opts.budgetTier ?? 'STANDARD';
  const requestPayload = JSON.stringify({ planId: plan.id });
  const repoWorkRequest: RepoWorkRequest = {
    budgetTier,
    connectionId: plan.connectionId,
    description: plan.intent,
    externalTicketId,
    // The run acts as, and uses the saved GitHub credential of, the person who approved it.
    launchedById: actor.sub,
    payload,
    repoId: plan.connectionId,
    requestPayload,
    workRequestId,
    workspaceProvider: 'git_repo',
    ...runProvenance({ actor, trigger: 'planned-run', triggerRefId: plan.id }),
  };

  const result = await launchTrackedWorkflow(
    deps.prisma,
    {
      activeWorkflow: {
        assignedBranch:
          plan.mode === 'delivering' ? generateBranchName(externalTicketId, branchPrefix) : null,
        budgetTier,
        currentStatus: 'IMPLEMENTING',
        repoId: plan.connectionId,
        temporalWorkflowId,
        workRequestId,
      },
      knowledgeSourceRepo: {
        orgId: repository.repo.orgId ?? '',
        repoId: repository.repo.id,
        teamId: repository.repo.teamId,
      },
      runInput: {
        connectionId: plan.connectionId,
        description: plan.intent,
        externalTicketId,
        id: workRequestId,
        payload: payload as object,
        requestedById: actor.sub,
        requestedByServiceId: null,
        requestPayload,
        templateId: template.id,
        templateVersion: template.activeVersion,
        // `plan-<id>` is generated here, not a tracker ticket.
        ticketIsSynthetic: true,
      },
    },
    () =>
      deps.temporal.startRunnableWorkflow(temporalWorkflowId, {
        request: repoWorkRequest,
        templateId: template.id,
        templateVersion: template.activeVersion as number,
      }),
    {
      audit: { actor, source: 'planned-run' },
      // Inside the ledger transaction: the plan must still be this person's APPROVED, unexpired
      // plan, so a rejection that landed after the checks above stops the launch before any row.
      guard: async (tx) => {
        const still = await tx.runPlan.findFirst({
          select: { id: true },
          where: {
            approvedById: actor.sub,
            expiresAt: { gt: nowOf(deps) },
            id: plan.id,
            ownerUserId: actor.sub,
            status: 'APPROVED',
            teamId: plan.teamId,
          },
        });
        return still ? null : 'PLAN_NOT_LAUNCHABLE';
      },
      log: deps.log ?? { error: () => undefined },
      sourceAuthorization: { actor: { role: Role.ENGINEER, sub: actor.sub } },
    }
  );
  if (!result.ok) {
    if (result.reason === 'GUARD_REFUSED') {
      return refuse(409, 'PLAN_NOT_LAUNCHABLE', 'The plan can no longer be launched');
    }
    return refuse(409, 'RUN_CONFLICT', 'A run for this plan is already starting');
  }
  return {
    activeWorkflowId: result.activeWorkflowId,
    ok: true,
    planId: plan.id,
    temporalWorkflowId,
    workRequestId,
  };
}

/**
 * Approve a plan and start its run. Every re-check and the admission run first, so a refusal
 * leaves the plan PENDING; the flip comes last, and a launch that then fails puts the plan back
 * to PENDING (only while it is still the APPROVED plan this call approved), so the owner can
 * approve it again instead of finding it stranded.
 */
export async function approveAndLaunchPlan(
  deps: RunPlanLaunchDeps,
  actor: PlanActor,
  planId: string,
  opts: { budgetTier?: RepoWorkRequest['budgetTier'] } = {}
): Promise<LaunchPlanResult> {
  const approved = await approvePlan(deps, actor, planId);
  if (!approved.ok) {
    return approved;
  }
  let launched: LaunchPlanResult;
  try {
    launched = await launchApprovedPlan(deps, actor, planId, opts);
  } catch (err) {
    await revertApproval(deps, approved.plan, actor);
    throw err;
  }
  if (!launched.ok) {
    await revertApproval(deps, approved.plan, actor);
  }
  return launched;
}

async function revertApproval(
  deps: RunPlanServiceDeps,
  plan: PlanRow,
  actor: PlanActor
): Promise<void> {
  try {
    await deps.prisma.runPlan.updateMany({
      data: { approvedAt: null, approvedById: null, status: 'PENDING' },
      where: {
        approvedById: actor.sub,
        id: plan.id,
        launchedWorkflowRunId: null,
        ownerUserId: actor.sub,
        status: 'APPROVED',
        teamId: plan.teamId,
      },
    });
  } catch (err) {
    // The plan stays APPROVED and unlaunched; `launchApprovedPlan` can be called again.
    deps.log?.warn(
      { err, planId: plan.id },
      'could not return a plan to PENDING after a failed launch'
    );
  }
}
