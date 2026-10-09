/**
 * The event-automation engine (docs/automations.md): one occurrence of an event source on a
 * repository → the first matching automation → one decision, recorded in the ledger
 * (`AutomationFire`) → at most one run.
 *
 * Everything decided here is decided from the signed webhook alone — no call to the host — and
 * a source's worker step decides again from the host's own record before anything is changed.
 * This side's job is to start at most one run per occurrence, and none when the limits say so:
 * the source's own exclusions, a subject already handled or produced by the platform, a scope
 * cooling down or still being worked on, the automation's daily cap, the organization's budget,
 * and the source's kill switch.
 */
import crypto from 'node:crypto';
import type { Prisma, PrismaClient } from '@auto-swe/shared';
import {
  type AutomationOutcome,
  buildAutomationPayload,
  type EventSource,
} from '@auto-swe/shared/automation';
import { resolveSetting } from '@auto-swe/shared/config';
import { isInputSchema } from '@auto-swe/shared/lib/inputSchema';
import { isInstallationRetired } from '@auto-swe/shared/lib/repoAccessDecision';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { ACTIVE_WORKFLOW_TERMINAL_STATUSES } from '@auto-swe/shared/types/api';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import type { FastifyInstance } from 'fastify';
import { getErrorName } from '../../plugins/auth.js';
import { isOrgOverBudget } from '../orgAccess.js';
import { webhookRepositoryWhere } from '../repositoryHost.js';
import { EXCLUDE_SYSTEM_TEMPLATES } from '../systemTemplate.js';
import { isValidTicketId } from '../ticketId.js';
import { launchTrackedWorkflow } from '../workflowLaunch.js';

/** Attempts at starting the workflow before the decision is given up. */
const START_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One occurrence of a source on a repository, from a verified webhook. */
export interface Occurrence<Facts> {
  org: string;
  repoName: string;
  repoFullName: string;
  repoHtmlUrl?: string;
  facts: Facts;
}

export type AutomationResult =
  | { ignored: true; reason: string }
  | { duplicate: true }
  | {
      automationId: string;
      outcome: AutomationOutcome;
      reason?: string;
      temporalWorkflowId?: string;
      workRequestId?: string;
    };

/** A start that failed after the decision was recorded. The fire row is removed for a retry. */
export class AutomationStartError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AutomationStartError';
  }
}

/** The fields of an automation the engine reads. */
export interface AutomationRow {
  id: string;
  enabled: boolean;
  source: string;
  filters: Prisma.JsonValue;
  inputs: Prisma.JsonValue;
  cooldownMinutes: number;
  maxRunsPerDay: number;
  templateId: string | null;
}

/**
 * An automation's filters as its source reads them, or null when they do not parse — and then
 * the automation matches nothing: a row that cannot be read fails closed.
 */
export function parseFilters<F>(source: EventSource<F, unknown>, raw: unknown): F | null {
  const parsed = source.filters.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Whether `automation` reacts to the occurrence. */
export function automationMatches<F, X>(
  source: EventSource<F, X>,
  automation: Pick<AutomationRow, 'enabled' | 'source' | 'filters'>,
  facts: X
): boolean {
  if (!automation.enabled || automation.source !== source.key) {
    return false;
  }
  const filters = parseFilters(source as EventSource<F, unknown>, automation.filters);
  return filters !== null && source.mismatch(filters, facts) === null;
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

/** `<host>/<owner>/<repo>`, lowercased: the repository, whichever connection row matched. */
export function repositoryKey(host: string, repoFullName: string): string {
  return `${host}/${repoFullName}`.toLowerCase();
}

/** What the engine loads of a repository row. */
export const connectionInclude = {
  automations: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
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
 * Act on one occurrence: find the first matching automation on the repository (oldest
 * repository row first, oldest automation first), decide, and start its run. At most one run
 * per occurrence, however many automations or repository rows match it.
 */
export async function handleOccurrence<F, X>(
  fastify: FastifyInstance,
  source: EventSource<F, X>,
  occurrence: Occurrence<X>,
  verifiedHost: string | null,
  now: Date = new Date(),
  startRetryDelayMs = 1_000
): Promise<AutomationResult> {
  const prisma = fastify.prisma;
  const { facts } = occurrence;
  const { branchPrefix } = await resolveWorkflowDefaults();
  const ignored = source.ignore?.(facts, { branchPrefix });
  if (ignored) {
    return { ignored: true, reason: ignored };
  }

  const repositoryWhere = await webhookRepositoryWhere(
    prisma,
    occurrence.org,
    occurrence.repoName,
    occurrence.repoHtmlUrl,
    verifiedHost
  );
  const connections = await runUnscoped(
    'a webhook names a host repository, not a team',
    ['Connection'],
    () =>
      prisma.connection.findMany({
        include: connectionInclude,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        where: { ...repositoryWhere, isActive: true, type: 'git_repo' },
      })
  );

  let match: { connection: (typeof connections)[number]; automation: AutomationRow } | null = null;
  for (const connection of connections) {
    if (isInstallationRetired(connection)) {
      continue;
    }
    const automation = connection.automations.find((a) => automationMatches(source, a, facts));
    if (automation) {
      match = { automation, connection };
      break;
    }
  }
  if (!match) {
    return { ignored: true, reason: 'no matching automation' };
  }
  const host = verifiedHost ?? hostOf(occurrence.repoHtmlUrl) ?? 'github';
  return decideAndStart(fastify, source, {
    ...match,
    facts,
    now,
    repoKey: repositoryKey(host, occurrence.repoFullName),
    // A redelivery takes a failed start again; any other earlier decision stands.
    retry: { kind: 'redelivery' },
    startRetryDelayMs,
  });
}

/** A repository row as the engine reads it: its automations, installation and team. */
export type EngineConnection = Prisma.ConnectionGetPayload<{ include: typeof connectionInclude }>;

/** Which earlier decision of the same occurrence a new one may replace. */
export type RetryScope =
  /** A redelivered webhook: only a `FAILED_TO_START` decision is taken again. */
  | { kind: 'redelivery' }
  /** A manager's retry of one recorded decision that did not start a run. */
  | { kind: 'manual'; fireId: string };

/**
 * Decide one occurrence for one matched automation and start its run. Shared by the webhook
 * path and a manager's retry, so a retry passes every limit a delivery does.
 */
export async function decideAndStart<F, X>(
  fastify: FastifyInstance,
  source: EventSource<F, X>,
  args: {
    connection: EngineConnection;
    automation: AutomationRow;
    facts: X;
    repoKey: string;
    now: Date;
    retry: RetryScope;
    startRetryDelayMs: number;
  }
): Promise<AutomationResult> {
  const prisma = fastify.prisma;
  const { connection, automation, facts, repoKey, now, startRetryDelayMs } = args;
  const { branchPrefix } = await resolveWorkflowDefaults();
  const orgId = connection.team?.orgId ?? undefined;
  const enabled = await resolveSetting(source.killSwitch, {
    ...(orgId ? { orgId } : {}),
    teamId: connection.teamId,
  });
  if (enabled !== true) {
    return { ignored: true, reason: `${source.label} automations are switched off` };
  }

  const keys = source.keys(facts);
  const fireBase = {
    automationId: automation.id,
    connectionId: connection.id,
    dedupeKey: source.dedupeKey(repoKey, facts),
    facts: facts as Prisma.InputJsonObject,
    repoKey,
    scopeKey: keys.scope,
    source: source.key,
    subjectKey: keys.subject,
  };

  // Taking an earlier decision again: it keeps its row, marked retried, and gives up the
  // dedupe key so the new decision can be recorded under it. Exactly one taker wins.
  const released = await releaseDecision(prisma, fireBase.dedupeKey, args.retry, now);
  if (!released) {
    return { duplicate: true };
  }

  // Decisions that need no lock: recorded once, by the dedupe key.
  const unmet = source.precondition?.(facts);
  if (unmet) {
    return recordDecision(prisma, fireBase, 'SUPPRESSED_PRECONDITION', unmet);
  }
  const org = connection.team?.organization;
  if (org && (await isOrgOverBudget(prisma, org.id, org.monthlyBudgetUsdCents))) {
    return recordDecision(
      prisma,
      fireBase,
      'SUPPRESSED_BUDGET',
      'the organization is over its monthly budget'
    );
  }
  const template = await resolveAutomationTemplate(
    prisma,
    source,
    automation.templateId,
    connection.teamId
  );
  if (!template) {
    fastify.log.warn(
      { automationId: automation.id },
      'automation has no active template to start; nothing started'
    );
    return recordDecision(
      prisma,
      fireBase,
      'FAILED_TO_START',
      'the automation template is not installed or not active'
    );
  }

  // Built and checked again at fire time: the template may have changed since the automation
  // was saved, and a payload the run would refuse must not spend one.
  const built = buildAutomationPayload(
    source,
    template.inputSchema,
    automation.inputs,
    connection.id,
    facts
  );
  if (!built.ok) {
    return recordDecision(
      prisma,
      fireBase,
      'FAILED_TO_START',
      `the automation's options do not fit its template: ${built.errors.join('; ').slice(0, 300)}`
    );
  }
  const run = source.run(facts);
  if (!isValidTicketId(run.ticketId)) {
    return { ignored: true, reason: 'the occurrence does not form a ticket id' };
  }
  const payload = built.payload;
  const workRequestId = crypto.randomUUID();
  const temporalWorkflowId = `${source.workflowId.prefix}-${automation.id.replace(/-/g, '').slice(0, 8)}-${source.workflowId.part(facts)}`;
  const request: RepoWorkRequest = {
    budgetTier: 'STANDARD',
    connectionId: connection.id,
    description: run.description,
    externalTicketId: run.ticketId,
    payload,
    repoId: connection.id,
    requestPayload: JSON.stringify(payload),
    workRequestId,
    workspaceProvider: 'git_repo',
  };

  let decided: { outcome: AutomationOutcome; reason: string } | null = null;
  let startAttempted = false;
  let launch: Awaited<ReturnType<typeof launchTrackedWorkflow>>;
  try {
    launch = await launchTrackedWorkflow(
      prisma,
      {
        activeWorkflow: {
          assignedBranch: `${branchPrefix}/${run.ticketId}`,
          budgetTier: 'STANDARD',
          currentStatus: 'IMPLEMENTING',
          repoId: connection.id,
          temporalWorkflowId,
          workRequestId,
        },
        runInput: {
          connectionId: connection.id,
          description: run.description,
          externalTicketId: run.ticketId,
          id: workRequestId,
          payload: payload as object,
          requestedById: null,
          requestPayload: JSON.stringify(payload),
          templateId: template.id,
          templateVersion: template.activeVersion,
          ticketIsSynthetic: run.ticketIsSynthetic,
        },
      },
      async () => {
        startAttempted = true;
        // A host does not redeliver a failed webhook by itself, so a transient Temporal error
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
          decided = await decideUnderLock(tx, { automation, repoKey }, source, keys, now, (id) =>
            fastify.temporal.isWorkflowGone(id)
          );
          await tx.automationFire.create({
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
    // rows were rolled back). Record it as a failed start: it no longer counts against later
    // occurrences, it shows in the history, and a redelivery or a retry takes it again. The
    // caller answers non-2xx.
    await prisma.automationFire
      .updateMany({
        data: {
          outcome: 'FAILED_TO_START',
          reason: 'the workflow could not be started; redeliver the event or retry the decision',
          temporalWorkflowId: null,
          workRequestId: null,
        },
        where: { dedupeKey: fireBase.dedupeKey, outcome: 'STARTED' },
      })
      .catch((cleanupErr: unknown) =>
        fastify.log.error(
          { dedupeKey: fireBase.dedupeKey, err: cleanupErr },
          'could not record an unstarted automation fire as failed'
        )
      );
    throw new AutomationStartError('The automation run could not be started', { cause: err });
  }
  if (launch.ok) {
    return { automationId: automation.id, outcome: 'STARTED', temporalWorkflowId, workRequestId };
  }
  if (launch.reason === 'GUARD_REFUSED') {
    const outcome = decided as { outcome: AutomationOutcome; reason: string } | null;
    return {
      automationId: automation.id,
      outcome: outcome?.outcome ?? 'FAILED_TO_START',
      reason: outcome?.reason,
    };
  }
  // The dedupe key (or the workflow id) was taken: another delivery already decided this one.
  return { duplicate: true };
}

/**
 * The checks that must see every earlier decision on the same repository, under a transaction
 * lock on the repository, so two deliveries cannot both pass them — however many automations or
 * repository rows they matched. Null: start the run.
 *
 * Every check reads only the occurrence's own source. Same subject, cooldown and in-flight are
 * judged across the repository's whole ledger (`repoKey`), which outlives any automation and
 * connection row: two automations matching two workflows that fail on one push must not open two
 * fixes, and deleting and recreating an automation must not forget what was done. Own output
 * matches the subject alone (`producedKey`), so it survives a repository rename. The daily cap
 * is the automation's own.
 */
export async function decideUnderLock<F, X>(
  tx: Prisma.TransactionClient,
  scope: {
    automation: Pick<AutomationRow, 'id' | 'cooldownMinutes' | 'maxRunsPerDay'>;
    repoKey: string;
  },
  source: Pick<EventSource<F, X>, 'inFlightLookbackMs' | 'key'>,
  keys: { scope: string; subject: string },
  now: Date,
  /** Whether Temporal says an execution is over. Throws when Temporal cannot say. */
  isWorkflowGone: (temporalWorkflowId: string) => Promise<boolean>
): Promise<{ outcome: AutomationOutcome; reason: string } | null> {
  const { automation, repoKey } = scope;
  // CLAUDE.md §7 exception: a transaction-scoped advisory lock serialises one repository's
  // decisions; Prisma has no way to express it.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`automation-repo:${repoKey}`}, 0))`;

  // Something a run of the platform produced (a pushed fix commit): acting on it would only
  // answer the platform's own output with more of it. Matched by the subject alone (a commit
  // sha names one commit wherever it is), so a repository renamed since still recognises it.
  if (
    await tx.automationFire.findFirst({ where: { producedKey: keys.subject, source: source.key } })
  ) {
    return {
      outcome: 'SUPPRESSED_OWN_OUTPUT',
      reason: 'it is the platform’s own output (a fix it pushed); it is not acted on again',
    };
  }
  // Every other guard counts only this source's decisions on this repository: another
  // source's subjects and scopes are other things, whatever their keys look like.
  const startedOnRepo = { outcome: 'STARTED', repoKey, source: source.key } as const;
  if (
    await tx.automationFire.findFirst({ where: { ...startedOnRepo, subjectKey: keys.subject } })
  ) {
    return {
      outcome: 'SUPPRESSED_SAME_SUBJECT',
      reason: 'a run was already started for this (another occurrence of it, or a re-run)',
    };
  }
  if (automation.cooldownMinutes > 0) {
    const since = new Date(now.getTime() - automation.cooldownMinutes * 60_000);
    const recent = await tx.automationFire.findFirst({
      where: { ...startedOnRepo, createdAt: { gte: since }, scopeKey: keys.scope },
    });
    if (recent) {
      return {
        outcome: 'SUPPRESSED_COOLDOWN',
        reason: `a run started for ${keys.scope} within the last ${automation.cooldownMinutes} minutes`,
      };
    }
  }
  const earlier = await tx.automationFire.findMany({
    select: { temporalWorkflowId: true },
    where: {
      ...startedOnRepo,
      createdAt: { gte: new Date(now.getTime() - source.inFlightLookbackMs) },
      scopeKey: keys.scope,
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
          reason: `an earlier run for ${keys.scope} is still in progress`,
        };
      }
    }
  }
  const today = await tx.automationFire.count({
    where: {
      automationId: automation.id,
      createdAt: { gte: new Date(now.getTime() - DAY_MS) },
      outcome: 'STARTED',
    },
  });
  if (today >= automation.maxRunsPerDay) {
    return {
      outcome: 'SUPPRESSED_DAILY_CAP',
      reason: `the automation started ${today} runs in the last 24 hours (cap ${automation.maxRunsPerDay})`,
    };
  }
  return null;
}

/**
 * Free the occurrence's dedupe key for a new decision, when the earlier one may be taken again.
 * True when the caller may decide: nothing recorded yet, or the earlier decision was released
 * by this call. False when another taker got there first (or, for a manual retry, the decision
 * is gone, started a run, or was already retried).
 */
async function releaseDecision(
  prisma: PrismaClient,
  dedupeKey: string,
  retry: RetryScope,
  now: Date
): Promise<boolean> {
  const where: Prisma.AutomationFireWhereInput =
    retry.kind === 'manual'
      ? { dedupeKey, id: retry.fireId, outcome: { not: 'STARTED' } }
      : { dedupeKey, outcome: 'FAILED_TO_START' };
  const earlier = await prisma.automationFire.findFirst({ select: { id: true }, where });
  if (!earlier) {
    // A redelivery of something never decided, or decided otherwise: the dedupe key decides.
    return retry.kind === 'redelivery';
  }
  // Moved aside under its own id, so the key is unique again and the row stays in the history.
  const { count } = await prisma.automationFire.updateMany({
    data: { dedupeKey: `${dedupeKey}~${earlier.id}`, retriedAt: now },
    where: { ...where, id: earlier.id },
  });
  return count === 1;
}

async function recordDecision(
  prisma: PrismaClient,
  fire: Omit<Prisma.AutomationFireUncheckedCreateInput, 'outcome' | 'reason'>,
  outcome: AutomationOutcome,
  reason: string
): Promise<AutomationResult> {
  try {
    await prisma.automationFire.create({ data: { ...fire, outcome, reason } });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      return { duplicate: true };
    }
    throw err;
  }
  return { automationId: fire.automationId as string, outcome, reason };
}

/**
 * The template an automation starts: its own, when it names one that is active, global or its
 * repository team's, not a system template, and that its source can start; otherwise the
 * source's default. Null when there is none to start.
 */
export async function resolveAutomationTemplate<F, X>(
  prisma: PrismaClient,
  source: Pick<EventSource<F, X>, 'defaultTemplate' | 'templateCompatible'>,
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
        where: { name: source.defaultTemplate.name, status: 'ACTIVE', teamId: null },
      });
  if (
    !row ||
    row.activeVersion === null ||
    !isInputSchema(row.inputSchema) ||
    !source.templateCompatible(row.inputSchema)
  ) {
    return null;
  }
  return { activeVersion: row.activeVersion, id: row.id, inputSchema: row.inputSchema };
}
