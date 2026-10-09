/**
 * CI-failure triggers: a GitHub `workflow_run` webhook for a failed run on a
 * connected repository starts the CI triage template, when a trigger on that
 * repository matches it (docs/ci-failure-triggers.md).
 *
 * Everything decided here is decided from the signed webhook alone — no call
 * to GitHub — and is decided again, from GitHub's own record of the run, by the
 * worker's `triageCiFailure` before anything is changed. This side's job is to
 * start at most one run per failed run attempt, and not to start one at all
 * when the rules say so: forks, the platform's own branches, other events,
 * a commit already handled, a branch cooling down or still being worked on,
 * the trigger's daily cap, the organization's budget, and the kill switch.
 */
import crypto from 'node:crypto';
import type { Prisma, PrismaClient } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import {
  buildCiTriggerPayload,
  CI_TRIAGE_TEMPLATE_NAME,
  type CiTriggerRule,
  ciTriggerMismatch,
  SAMPLE_CI_EVENT_FIELDS,
} from '@auto-swe/shared/lib/ciTrigger';
import { isPlatformWorkBranch, isSafeGitBranchName } from '@auto-swe/shared/lib/gitRef';
import { isInputSchema, validateInputPayload } from '@auto-swe/shared/lib/inputSchema';
import { isInstallationRetired } from '@auto-swe/shared/lib/repoAccessDecision';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { ACTIVE_WORKFLOW_TERMINAL_STATUSES } from '@auto-swe/shared/types/api';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getErrorName } from '../plugins/auth.js';
import { isOrgOverBudget } from './orgAccess.js';
import { webhookRepositoryWhere } from './repositoryHost.js';
import { EXCLUDE_SYSTEM_TEMPLATES } from './systemTemplate.js';
import { isValidTicketId } from './ticketId.js';
import { launchTrackedWorkflow } from './workflowLaunch.js';

/** What a trigger decided about one failed run. */
export const CI_FIRE_OUTCOMES = [
  'STARTED',
  'SUPPRESSED_OWN_FIX',
  'SUPPRESSED_SAME_COMMIT',
  'SUPPRESSED_COOLDOWN',
  'SUPPRESSED_IN_FLIGHT',
  'SUPPRESSED_DAILY_CAP',
  'SUPPRESSED_NO_PULL_REQUEST',
  'SUPPRESSED_BUDGET',
  'FAILED_TO_START',
] as const;
export type CiFireOutcome = (typeof CI_FIRE_OUTCOMES)[number];

/**
 * How far back a started run still counts as possibly in flight: longer than the template can
 * run (an implementation, then up to six CI waits of four hours — the first, and one after each
 * of at most five revisions).
 */
const IN_FLIGHT_LOOKBACK_MS = 36 * 60 * 60 * 1000;
/** Attempts at starting the workflow before the decision is given up. */
const START_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const WorkflowRunWebhookSchema = z.object({
  action: z.string(),
  repository: z.object({
    full_name: z.string(),
    html_url: z.string().optional(),
    id: z.number(),
  }),
  workflow_run: z.object({
    conclusion: z.string().nullish(),
    event: z.string(),
    head_branch: z.string().nullish(),
    head_repository: z.object({ full_name: z.string(), id: z.number() }).nullish(),
    head_sha: z.string(),
    html_url: z.string().optional(),
    id: z.number().int().positive(),
    path: z.string(),
    pull_requests: z
      .array(
        z.object({
          base: z.object({ ref: z.string(), repo: z.object({ id: z.number() }).nullish() }),
          head: z.object({ ref: z.string(), repo: z.object({ id: z.number() }).nullish() }),
          number: z.number().int().positive(),
        })
      )
      .nullish(),
    run_attempt: z.number().int().min(1).optional(),
    status: z.string().nullish(),
  }),
});

/** A failed workflow run the triggers may act on, from a `workflow_run` webhook. */
export interface WorkflowRunFailedEvent {
  type: 'failed';
  org: string;
  repoName: string;
  repoFullName: string;
  repoHtmlUrl?: string;
  runId: string;
  runAttempt: number;
  workflowPath: string;
  event: 'push' | 'pull_request';
  headBranch: string;
  headSha: string;
  /** The open same-repository pull request the run is for, when the event is `pull_request`. */
  pullRequestNumber: number | null;
}

export type WorkflowRunEvent =
  | WorkflowRunFailedEvent
  | { type: 'unrecognized' }
  | { type: 'ignored'; reason: string };

/**
 * Pure mapping from a `workflow_run` webhook body to the failure a trigger may
 * act on. Everything that is never acted on is ignored here, before any query.
 */
export function normalizeWorkflowRunEvent(body: unknown): WorkflowRunEvent {
  const parsed = WorkflowRunWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return { type: 'unrecognized' };
  }
  const { action, repository, workflow_run: run } = parsed.data;
  if (action !== 'completed') {
    return { reason: `action ${action}`, type: 'ignored' };
  }
  if (run.conclusion !== 'failure' && run.conclusion !== 'timed_out') {
    return { reason: `conclusion ${run.conclusion ?? 'none'}`, type: 'ignored' };
  }
  if (run.event !== 'push' && run.event !== 'pull_request') {
    return { reason: `event ${run.event} is never acted on`, type: 'ignored' };
  }
  // A fork's code, a fork's logs: never. Compared by id, which a rename cannot change.
  if (!run.head_repository || run.head_repository.id !== repository.id) {
    return { reason: 'the run is for a commit from a fork', type: 'ignored' };
  }
  const headBranch = run.head_branch ?? '';
  if (!isSafeGitBranchName(headBranch)) {
    return { reason: 'the run names no usable branch', type: 'ignored' };
  }
  const [org, repoName] = repository.full_name.split('/');
  if (!org || !repoName) {
    return { type: 'unrecognized' };
  }
  let pullRequestNumber: number | null = null;
  if (run.event === 'pull_request') {
    // The pull request from this branch of this repository. GitHub lists none for a fork, may
    // list none once it closed, and may list several (one per base); the first is used.
    const pr = (run.pull_requests ?? []).find(
      (p) => p.head.ref === headBranch && p.head.repo?.id === repository.id
    );
    pullRequestNumber = pr?.number ?? null;
  }
  return {
    event: run.event,
    headBranch,
    headSha: run.head_sha,
    org,
    pullRequestNumber,
    repoFullName: repository.full_name,
    repoHtmlUrl: repository.html_url,
    repoName,
    runAttempt: run.run_attempt ?? 1,
    runId: String(run.id),
    type: 'failed',
    workflowPath: run.path,
  };
}

/** Whether `trigger` reacts to `event`. Workflows are matched by FILE path, never display name. */
export function triggerMatches(trigger: CiTriggerRule, event: WorkflowRunFailedEvent): boolean {
  return (
    ciTriggerMismatch(trigger, {
      branch: event.headBranch,
      event: event.event,
      workflowPath: event.workflowPath,
    }) === null
  );
}

/**
 * The run's identity on its host, lowercased: what makes a second delivery, or a second
 * trigger or repository row matching the same run, a duplicate.
 */
export function fireDedupeKey(
  host: string,
  event: Pick<WorkflowRunFailedEvent, 'repoFullName' | 'runId' | 'runAttempt'>
): string {
  return `${host}/${event.repoFullName}#${event.runId}/${event.runAttempt}`.toLowerCase();
}

function hostOf(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** A workflow path safe to quote in the task text: plain path characters only. */
function quotablePath(path: string): string {
  return /^[\w./-]{1,200}$/.test(path) ? path : 'a GitHub Actions workflow';
}

export type CiTriggerResult =
  | { ignored: true; reason: string }
  | { duplicate: true }
  | {
      triggerId: string;
      outcome: CiFireOutcome;
      reason?: string;
      temporalWorkflowId?: string;
      workRequestId?: string;
    };

/** A start that failed after the decision was recorded. The fire row is removed for a retry. */
export class CiTriggerStartError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CiTriggerStartError';
  }
}

const connectionInclude = {
  ciFailureTriggers: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  installation: { select: { isActive: true } },
  team: {
    select: {
      id: true,
      organization: { select: { id: true, monthlyBudgetUsdCents: true } },
      orgId: true,
    },
  },
} satisfies Prisma.ConnectionInclude;

/**
 * Act on a failed workflow run: find the first matching trigger on the
 * repository, decide, and start the triage run. At most one run per run
 * attempt, however many triggers or repository rows match it.
 */
export async function handleWorkflowRunFailure(
  fastify: FastifyInstance,
  event: WorkflowRunFailedEvent,
  verifiedHost: string | null,
  now: Date = new Date(),
  startRetryDelayMs = 1_000
): Promise<CiTriggerResult> {
  const prisma = fastify.prisma;
  const { branchPrefix } = await resolveWorkflowDefaults();
  // The platform's own runs have their own CI loop, and a fix PR whose CI fails must not
  // trigger a fix of the fix.
  if (isPlatformWorkBranch(event.headBranch, branchPrefix)) {
    return { ignored: true, reason: 'a platform work branch' };
  }

  const repositoryWhere = await webhookRepositoryWhere(
    prisma,
    event.org,
    event.repoName,
    event.repoHtmlUrl,
    verifiedHost
  );
  const connections = await runUnscoped(
    'a workflow_run webhook names a GitHub repository, not a team',
    ['Connection'],
    () =>
      prisma.connection.findMany({
        include: connectionInclude,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        where: { ...repositoryWhere, isActive: true, type: 'git_repo' },
      })
  );

  // The first matching trigger, oldest repository row first, oldest trigger first.
  let match: { connection: (typeof connections)[number]; trigger: TriggerRow } | null = null;
  for (const connection of connections) {
    if (isInstallationRetired(connection)) {
      continue;
    }
    const trigger = connection.ciFailureTriggers.find((t) => triggerMatches(t, event));
    if (trigger) {
      match = { connection, trigger };
      break;
    }
  }
  if (!match) {
    return { ignored: true, reason: 'no matching trigger' };
  }
  const { connection, trigger } = match;
  const orgId = connection.team?.orgId ?? undefined;
  const enabled = await resolveSetting('github.ciFailureTriggersEnabled', {
    ...(orgId ? { orgId } : {}),
    teamId: connection.teamId,
  });
  if (!enabled) {
    return { ignored: true, reason: 'CI-failure triggers are switched off' };
  }

  const host = verifiedHost ?? hostOf(event.repoHtmlUrl) ?? 'github';
  const dedupeKey = fireDedupeKey(host, event);
  const fireBase = {
    dedupeKey,
    event: event.event,
    githubRunId: event.runId,
    headBranch: event.headBranch,
    headSha: event.headSha,
    pullRequestNumber: event.pullRequestNumber,
    runAttempt: event.runAttempt,
    triggerId: trigger.id,
    workflowPath: event.workflowPath.slice(0, 500),
  };

  // Decisions that need no lock: recorded once, by the dedupe key.
  if (event.event === 'pull_request' && event.pullRequestNumber === null) {
    return recordSuppression(
      prisma,
      fireBase,
      'SUPPRESSED_NO_PULL_REQUEST',
      'no open pull request from this branch'
    );
  }
  const org = connection.team?.organization;
  if (org && (await isOrgOverBudget(prisma, org.id, org.monthlyBudgetUsdCents))) {
    return recordSuppression(
      prisma,
      fireBase,
      'SUPPRESSED_BUDGET',
      'the organization is over its monthly budget'
    );
  }

  const template = await resolveTriggerTemplate(prisma, trigger.templateId, connection.teamId);
  if (!template) {
    fastify.log.warn(
      { triggerId: trigger.id },
      'CI-failure trigger has no active template to start; nothing started'
    );
    return recordSuppression(
      prisma,
      fireBase,
      'FAILED_TO_START',
      'the trigger template is not installed or not active'
    );
  }

  const runId8 = event.runId.slice(-12);
  const ticketId = `ci-${event.runId}-${event.runAttempt}`;
  if (!isValidTicketId(ticketId)) {
    return { ignored: true, reason: 'the run id does not form a ticket id' };
  }
  const workRequestId = crypto.randomUUID();
  const temporalWorkflowId = `ci-${trigger.id.replace(/-/g, '').slice(0, 8)}-${runId8}-${event.runAttempt}`;
  const description =
    `Fix the failing ${quotablePath(event.workflowPath)} on ${event.headBranch} ` +
    `(commit ${event.headSha.slice(0, 12)}).`;
  // Built and checked again at fire time: the template may have changed since the trigger
  // was saved, and a payload the worker would refuse must not spend a run.
  const built = buildCiTriggerPayload(template.inputSchema, trigger.inputs, {
    baseBranch: event.headBranch,
    connectionId: connection.id,
    description,
    githubRunId: event.runId,
    pullRequestNumber: event.pullRequestNumber,
    runAttempt: event.runAttempt,
    ticketId,
  });
  if (!built.ok) {
    return recordSuppression(
      prisma,
      fireBase,
      'FAILED_TO_START',
      `the trigger's options do not fit its template: ${built.errors.join('; ').slice(0, 300)}`
    );
  }
  const payload = built.payload;

  const request: RepoWorkRequest = {
    budgetTier: 'STANDARD',
    connectionId: connection.id,
    description,
    externalTicketId: ticketId,
    payload,
    repoId: connection.id,
    requestPayload: JSON.stringify(payload),
    workRequestId,
    workspaceProvider: 'git_repo',
  };

  let decided: { outcome: CiFireOutcome; reason: string } | null = null;
  let startAttempted = false;
  let launch: Awaited<ReturnType<typeof launchTrackedWorkflow>>;
  try {
    launch = await launchTrackedWorkflow(
      prisma,
      {
        activeWorkflow: {
          assignedBranch: `${branchPrefix}/${ticketId}`,
          budgetTier: 'STANDARD',
          currentStatus: 'IMPLEMENTING',
          repoId: connection.id,
          temporalWorkflowId,
          workRequestId,
        },
        runInput: {
          connectionId: connection.id,
          description,
          externalTicketId: ticketId,
          id: workRequestId,
          payload: payload as object,
          requestedById: null,
          requestPayload: JSON.stringify(payload),
          templateId: template.id,
          templateVersion: template.activeVersion,
          ticketIsSynthetic: true,
        },
      },
      async () => {
        startAttempted = true;
        // GitHub does not redeliver a failed webhook by itself, so a transient Temporal error
        // is retried here. A retry that finds the execution already started means an earlier
        // attempt did start it (its reply was lost): that is success, not a duplicate.
        for (let attempt = 1; ; attempt++) {
          try {
            await fastify.temporal.startRunnableWorkflow(temporalWorkflowId, {
              request,
              templateId: template.id,
              templateVersion: template.activeVersion,
            });
            return;
          } catch (err) {
            if (attempt > 1 && getErrorName(err) === 'WorkflowExecutionAlreadyStartedError') {
              return;
            }
            if (
              attempt >= START_ATTEMPTS ||
              getErrorName(err) === 'WorkflowExecutionAlreadyStartedError'
            ) {
              throw err;
            }
            await new Promise((r) => setTimeout(r, startRetryDelayMs * attempt));
          }
        }
      },
      {
        guard: async (tx) => {
          decided = await decideUnderLock(
            tx,
            {
              connectionIds: connections.map((c) => c.id),
              repoKey: `${host}/${event.repoFullName}`.toLowerCase(),
              trigger,
            },
            event,
            now,
            (id) => fastify.temporal.isWorkflowGone(id)
          );
          await tx.ciFailureTriggerFire.create({
            data: {
              ...fireBase,
              outcome: decided?.outcome ?? 'STARTED',
              reason: decided?.reason ?? null,
              ...(decided ? {} : { temporalWorkflowId, workRequestId }),
            },
          });
          return decided ? decided.outcome : null;
        },
        log: fastify.log,
      }
    );
  } catch (err) {
    if (!startAttempted) {
      // The decision itself failed (the database): nothing was committed.
      throw err;
    }
    // The decision was STARTED and committed, but the workflow did not start (the ledger
    // rows were rolled back). Remove the fire so a redelivery can try again, and tell the
    // caller to answer non-2xx.
    await prisma.ciFailureTriggerFire
      .deleteMany({ where: { dedupeKey, outcome: 'STARTED' } })
      .catch((cleanupErr: unknown) =>
        fastify.log.error({ dedupeKey, err: cleanupErr }, 'could not remove an unstarted CI fire')
      );
    throw new CiTriggerStartError('The CI triage run could not be started', { cause: err });
  }
  if (launch.ok) {
    return { outcome: 'STARTED', temporalWorkflowId, triggerId: trigger.id, workRequestId };
  }
  if (launch.reason === 'GUARD_REFUSED') {
    const outcome = (decided as { outcome: CiFireOutcome; reason: string } | null) ?? null;
    return {
      outcome: outcome?.outcome ?? 'FAILED_TO_START',
      reason: outcome?.reason,
      triggerId: trigger.id,
    };
  }
  // The dedupe key (or the workflow id) was taken: another delivery already decided this run.
  return { duplicate: true };
}

type TriggerRow = {
  id: string;
  enabled: boolean;
  /** The template options the trigger sets (`TriggerInputsSchema`). */
  inputs: Prisma.JsonValue;
  events: string[];
  branchPatterns: string[];
  workflowPatterns: string[];
  cooldownMinutes: number;
  maxRunsPerDay: number;
  templateId: string | null;
};

/**
 * The checks that must see every earlier decision on the same repository, under a transaction
 * lock on the repository, so two deliveries cannot both pass them — however many triggers or
 * repository rows they matched. Null: start the run.
 *
 * Same commit, cooldown and in-flight are judged across every trigger of the repository (its
 * `connectionIds`): two triggers matching two workflows that fail on one push must not open two
 * fixes into one branch. The daily cap is the trigger's own.
 */
export async function decideUnderLock(
  tx: Prisma.TransactionClient,
  scope: {
    trigger: Pick<TriggerRow, 'id' | 'cooldownMinutes' | 'maxRunsPerDay'>;
    /** `<host>/<owner>/<repo>`, lowercased: the repository, whichever row matched. */
    repoKey: string;
    /** Every connection row of the repository. */
    connectionIds: string[];
  },
  event: Pick<WorkflowRunFailedEvent, 'headBranch' | 'headSha'>,
  now: Date,
  /** Whether Temporal says an execution is over. Throws when Temporal cannot say. */
  isWorkflowGone: (temporalWorkflowId: string) => Promise<boolean>
): Promise<{ outcome: CiFireOutcome; reason: string } | null> {
  const { trigger } = scope;
  // CLAUDE.md §7 exception: a transaction-scoped advisory lock serialises one repository's
  // decisions; Prisma has no way to express it.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ci-repo:${scope.repoKey}`}, 0))`;

  const startedOnRepo = {
    outcome: 'STARTED',
    trigger: { connectionId: { in: scope.connectionIds } },
  } as const;
  // A commit the platform pushed as a fix: its failure is the fix failing, which a new run
  // would only answer with a fix of the fix. Matched across every trigger of the repository.
  if (
    await tx.ciFailureTriggerFire.findFirst({
      where: {
        fixCommitSha: event.headSha,
        trigger: { connectionId: { in: scope.connectionIds } },
      },
    })
  ) {
    return {
      outcome: 'SUPPRESSED_OWN_FIX',
      reason: 'the commit is a fix the platform pushed; its failure is not triaged again',
    };
  }
  if (
    await tx.ciFailureTriggerFire.findFirst({ where: { ...startedOnRepo, headSha: event.headSha } })
  ) {
    return {
      outcome: 'SUPPRESSED_SAME_COMMIT',
      reason: 'a run was already started for this commit (another workflow, or a re-run)',
    };
  }
  if (trigger.cooldownMinutes > 0) {
    const since = new Date(now.getTime() - trigger.cooldownMinutes * 60_000);
    const recent = await tx.ciFailureTriggerFire.findFirst({
      where: { ...startedOnRepo, createdAt: { gte: since }, headBranch: event.headBranch },
    });
    if (recent) {
      return {
        outcome: 'SUPPRESSED_COOLDOWN',
        reason: `a run started for this branch within the last ${trigger.cooldownMinutes} minutes`,
      };
    }
  }
  const earlier = await tx.ciFailureTriggerFire.findMany({
    select: { temporalWorkflowId: true },
    where: {
      ...startedOnRepo,
      createdAt: { gte: new Date(now.getTime() - IN_FLIGHT_LOOKBACK_MS) },
      headBranch: event.headBranch,
      temporalWorkflowId: { not: null },
    },
  });
  const ids = earlier.map((f) => f.temporalWorkflowId as string);
  if (ids.length > 0) {
    const open = await tx.activeWorkflow.findMany({
      select: { temporalWorkflowId: true },
      where: {
        currentStatus: { notIn: [...ACTIVE_WORKFLOW_TERMINAL_STATUSES] },
        temporalWorkflowId: { in: ids },
      },
    });
    for (const row of open) {
      // The ledger row is not the truth: an execution terminated before it finalized never
      // closes its row. Temporal decides; a Temporal that cannot answer counts as running.
      const gone = await isWorkflowGone(row.temporalWorkflowId).catch(() => false);
      if (!gone) {
        return {
          outcome: 'SUPPRESSED_IN_FLIGHT',
          reason: 'an earlier run for this branch is still in progress',
        };
      }
    }
  }
  const today = await tx.ciFailureTriggerFire.count({
    where: {
      createdAt: { gte: new Date(now.getTime() - DAY_MS) },
      outcome: 'STARTED',
      triggerId: trigger.id,
    },
  });
  if (today >= trigger.maxRunsPerDay) {
    return {
      outcome: 'SUPPRESSED_DAILY_CAP',
      reason: `the trigger started ${today} runs in the last 24 hours (cap ${trigger.maxRunsPerDay})`,
    };
  }
  return null;
}

async function recordSuppression(
  prisma: PrismaClient,
  fire: Omit<Prisma.CiFailureTriggerFireUncheckedCreateInput, 'outcome' | 'reason'>,
  outcome: CiFireOutcome,
  reason: string
): Promise<CiTriggerResult> {
  try {
    await prisma.ciFailureTriggerFire.create({ data: { ...fire, outcome, reason } });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      return { duplicate: true };
    }
    throw err;
  }
  return { outcome, reason, triggerId: fire.triggerId };
}

/**
 * Whether a template is CI-aware: its declared input schema names `githubRunId` (a template
 * that does not is not, whatever it accepts) and takes what a failing run fills in. A template
 * with no schema accepts anything, so it is refused. Whether a trigger's options fit it is
 * `buildCiTriggerPayload`'s question, so an option the template requires is not checked here.
 */
export function acceptsCiPayload(inputSchema: unknown): boolean {
  if (!isInputSchema(inputSchema) || !('githubRunId' in inputSchema.properties)) {
    return false;
  }
  const runFields: Record<string, unknown> = { ...SAMPLE_CI_EVENT_FIELDS };
  return validateInputPayload(
    {
      ...inputSchema,
      required: (inputSchema.required ?? []).filter((k) => k in runFields),
    },
    runFields
  ).ok;
}

/**
 * The template a trigger starts: its own, when it names one that is active, global or its
 * repository team's, not a system template, and accepts the CI payload; otherwise the
 * built-in `ci-triage-and-fix`. Null when there is none to start.
 */
export async function resolveTriggerTemplate(
  prisma: PrismaClient,
  templateId: string | null,
  teamId: string
): Promise<{ id: string; activeVersion: number; inputSchema: unknown } | null> {
  const select = { activeVersion: true, id: true, inputSchema: true } as const;
  const row = templateId
    ? await prisma.workflowTemplate.findFirst({
        select,
        where: {
          AND: [
            { id: templateId, OR: [{ teamId: null }, { teamId }], status: 'ACTIVE' },
            EXCLUDE_SYSTEM_TEMPLATES,
          ],
        },
      })
    : await prisma.workflowTemplate.findFirst({
        orderBy: [{ updatedAt: 'desc' }],
        select,
        where: { name: CI_TRIAGE_TEMPLATE_NAME, status: 'ACTIVE', teamId: null },
      });
  if (!row || row.activeVersion === null || !acceptsCiPayload(row.inputSchema)) {
    return null;
  }
  return { activeVersion: row.activeVersion, id: row.id, inputSchema: row.inputSchema };
}
