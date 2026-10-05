import crypto from 'node:crypto';
import type { RunIdentity } from '@auto-swe/shared/lib/repoAccessGate';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { generateBranchName } from '@auto-swe/shared/lib/workflowId';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authorizeLaunch, sendLaunchRefusal } from '../lib/launchAuthorization.js';
import { EXCLUDE_SYSTEM_TEMPLATES } from '../lib/systemTemplate.js';
import { memberTeams, reachableConnections } from '../lib/tenantScope.js';
import { type JwtPayload, requireAuth, requireUser } from '../plugins/auth.js';
import type { WorkRequestScheduleInput } from '../plugins/temporal.js';
import { resolveDefaultTemplate } from './workRequests.js';

/**
 * Scheduled / recurring work requests — standing automation on top of the
 * existing RunnableWorkflow machinery (e.g. run the dependencyUpdate template
 * weekly against a repo).
 *
 * Design (see also `ScheduledWorkRequest` in schema.prisma):
 * - Each row owns one Temporal Schedule whose action starts RunnableWorkflow
 *   directly with base workflowId `sched-<rowId>`. Temporal appends the
 *   per-fire scheduled timestamp to the workflow ID, so every fire is a fresh
 *   execution with its own WorkflowRun row.
 * - Schedule action args are static, so per-fire WorkRequest rows can't be
 *   created. Instead one standing WorkRequest is created at save time and all
 *   fires' WorkflowRuns link to it. A standing "anchor" ActiveWorkflow row
 *   (temporalWorkflowId = `sched-<rowId>`, status SCHEDULED) carries the
 *   repo / branch / budget tier and gives `createOrUpdatePullRequest` a
 *   workRequestId → workflow join so repeat fires update an still-open PR
 *   instead of erroring on a duplicate branch PR.
 * - Template resolution (explicit override or team default) happens at save
 *   time — snapshot semantics, same as interactive work requests.
 */

/**
 * Conservative 5-field cron validation: numbers, `*`, ranges, steps, lists.
 * Deliberately excludes names (JAN/MON), `?`, `L`, `W`, `#`, and 6/7-field
 * variants — Temporal accepts more, but this is the safe portable subset.
 */
const CRON_FIELD = String.raw`(\*|\d{1,2})(-\d{1,2})?(/\d{1,2})?(,(\*|\d{1,2})(-\d{1,2})?(/\d{1,2})?)*`;
export const CRON_5_FIELD_RE = new RegExp(`^${CRON_FIELD}( ${CRON_FIELD}){4}$`);

const CRON_MESSAGE =
  'must be a 5-field cron expression (minute hour day-of-month month day-of-week) using numbers, *, ranges, steps and lists only';

const BudgetTierSchema = z.enum(['STANDARD', 'LARGE', 'EPIC']);

const CreateScheduleSchema = z.object({
  budgetTier: BudgetTierSchema.optional().default('STANDARD'),
  cronExpression: z.string().regex(CRON_5_FIELD_RE, CRON_MESSAGE),
  description: z.string().min(1, 'description is required — tell the agent what to do each fire'),
  externalTicketPrefix: z
    .string()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'prefix must be alphanumeric, starting with a letter'),
  isActive: z.boolean().optional().default(true),
  name: z.string().min(1).max(200),
  repoId: z.string().uuid(),
  /** The owning team: the repository's team or one it is shared with. See `resolveCreateTeam`. */
  teamId: z.string().uuid().optional(),
  /** Explicit template override; omitted → repo team default at save time. */
  templateId: z.string().uuid().optional(),
  /** Pin a version; omitted with templateId → that template's activeVersion. */
  templateVersion: z.number().int().min(1).optional(),
});

const UpdateScheduleSchema = z.object({
  budgetTier: BudgetTierSchema.optional(),
  cronExpression: z.string().regex(CRON_5_FIELD_RE, CRON_MESSAGE).optional(),
  description: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
  name: z.string().min(1).max(200).optional(),
  /** Set to null to clear an override and fall back to the team default. */
  templateId: z.string().uuid().nullable().optional(),
  templateVersion: z.number().int().min(1).nullable().optional(),
});

const IdParams = z.object({ id: z.string().uuid() });

type Prisma = FastifyInstance['prisma'];

/**
 * The repository row this route works with, derived from the query rather than
 * declared alongside it.
 *
 * It used to be a hand-written interface reconciled with an
 * `as RepoWithMembership | null` cast. A type assertion succeeds when either
 * side is assignable to the other, so the cast was quietly bridging two real
 * gaps: the interface claimed `organizationName: string` where Prisma returns
 * `string | null`, and it would equally have accepted a `select` that dropped
 * `githubApiUrl` — after which the permission lookup asks github.com about a
 * GitHub Enterprise repository and caches the answer under the Enterprise
 * connection's id. Deriving the type is what makes the required fields on
 * `RepoAccessSubject` mean anything here.
 */
type RepoWithMembership = NonNullable<Awaited<ReturnType<typeof loadRepoWithMembership>>>;

async function loadRepoWithMembership(prisma: Prisma, repoId: string, userId: string) {
  // findFirst (not findUnique) so we can scope to git_repo — a scheduled work
  // request only targets git repos; a non-git id (e.g. mcp) resolves to null and
  // the caller rejects it like a missing/forbidden repo.
  // No `as RepoWithMembership` cast here. A type assertion succeeds when either
  // side is assignable to the other, so a `select` that dropped `githubApiUrl`
  // would assert cleanly into a type requiring it — and the permission lookup
  // would then ask github.com about a GitHub Enterprise repository and cache
  // the answer. Letting the inferred type flow is what makes the required
  // fields on `RepoAccessSubject` mean anything at this call site.
  return prisma.connection.findFirst({
    include: {
      installation: { select: { host: true, installationId: true, isActive: true } },
      // Shared-team membership satisfies the launch decision, and a LEAD of a
      // shared team may schedule on the repository (see `canCreate`). The share's
      // `teamId` is what a schedule's own `teamId` is matched against.
      shares: {
        select: {
          team: {
            select: { memberships: { select: { role: true, userId: true }, where: { userId } } },
          },
          teamId: true,
        },
      },
      team: {
        select: {
          memberships: { select: { role: true, userId: true }, where: { userId } },
          organization: { select: { id: true, monthlyBudgetUsdCents: true } },
          orgId: true,
        },
      },
    },
    where: { id: repoId, type: 'git_repo' },
  });
}

/**
 * The launch decision, for the endpoints that cause a push or put a schedule in
 * a position to.
 *
 * A schedule is a standing instruction to push, open pull requests and spend, so
 * creating one, firing one and (re-)activating one are launch paths in exactly
 * the same sense as submitting a work request: repository access, org
 * membership and the org's monthly cap. Gating only the interactive submit would
 * leave a schedule as a way to keep acting on a repository after access was
 * revoked. Pausing and deleting are not gated: neither causes a push, and
 * refusing either would strand a schedule its owner can no longer stop.
 *
 * `runIdentity` is whose GitHub identity the decision is about. `'caller'` when
 * the person being judged is who the schedule will run as (creating one, or
 * rebinding one to themselves), so their own saved token is what is asked about;
 * `'platform'` when they are only pressing a button on someone else's schedule,
 * which launches as its author.
 *
 * Returns false having already sent the reply.
 */
async function passesLaunchAuthorization(
  fastify: FastifyInstance,
  request: FastifyRequest,
  user: JwtPayload,
  repo: RepoWithMembership,
  reply: FastifyReply,
  runIdentity: RunIdentity
): Promise<boolean> {
  const authorization = await authorizeLaunch(fastify.prisma, user, {
    gate: request.repoAccessGate,
    log: request.log,
    repos: [repo],
    runIdentity,
  });
  if (authorization.ok) {
    return true;
  }
  await sendLaunchRefusal(reply, authorization.refusal);
  return false;
}

const isLead = (m: { role: string } | undefined): boolean =>
  !!m && (m.role === 'LEAD' || m.role === 'ADMIN');

/** Whether the caller leads the repository's owning team. */
function leadsOwner(repo: RepoWithMembership): boolean {
  return isLead(repo.team.memberships[0]);
}

/**
 * The teams the caller leads that may own a schedule on this repository: its
 * owning team and the teams it is shared with. Platform ADMIN's own membership
 * is irrelevant here; callers check the role first.
 */
function ledScheduleTeamIds(repo: RepoWithMembership): string[] {
  return [
    ...(leadsOwner(repo) ? [repo.teamId] : []),
    ...repo.shares.filter((s) => isLead(s.team.memberships[0])).map((s) => s.teamId),
  ];
}

/** Who may create a schedule: ADMIN, or a LEAD of the owning team or of a shared team. */
function canCreate(user: { role: string }, repo: RepoWithMembership): boolean {
  return user.role === 'ADMIN' || ledScheduleTeamIds(repo).length > 0;
}

/**
 * Who may edit, fire or delete a schedule: ADMIN; a LEAD of the schedule's own
 * team; or a LEAD of the repository's owning team, which keeps authority over
 * every schedule on its repository. A shared team's lead cannot touch another
 * team's schedule, and a team no longer shared has no standing at all: it is no
 * longer in `repo.shares`.
 *
 * A null `teamId` is a schedule whose team was deleted (the migration backfills
 * every earlier row). Nobody can say whose it was, so it is managed
 * conservatively: ADMIN or the owning team's lead only, never a shared team's.
 */
function canManage(
  user: { role: string },
  repo: RepoWithMembership,
  schedule: { teamId: string | null }
): boolean {
  if (user.role === 'ADMIN' || leadsOwner(repo)) {
    return true;
  }
  return !!schedule.teamId && ledScheduleTeamIds(repo).includes(schedule.teamId);
}

const FORBIDDEN_MESSAGE =
  "Requires ADMIN role, or LEAD membership on the schedule's team or the repository's owning team";

/**
 * The team a new schedule belongs to. An explicit `teamId` must be the owning
 * team or a shared team the caller leads (ADMIN: any of those). Without one:
 * the owning team if the caller leads it (or is ADMIN), else the single shared
 * team they lead.
 */
function resolveCreateTeam(
  user: { role: string },
  repo: RepoWithMembership,
  requested: string | undefined
): { teamId: string } | { status: 400 | 403; code: string; message: string } {
  const admin = user.role === 'ADMIN';
  const led = ledScheduleTeamIds(repo);
  if (requested) {
    const eligible = requested === repo.teamId || repo.shares.some((s) => s.teamId === requested);
    if (!eligible) {
      return {
        code: 'INVALID_SCHEDULE_TEAM',
        message: 'teamId must be the repository owning team or a team it is shared with',
        status: 400,
      };
    }
    return admin || led.includes(requested)
      ? { teamId: requested }
      : { code: 'FORBIDDEN', message: 'Requires LEAD membership on that team', status: 403 };
  }
  if (admin || led.includes(repo.teamId)) {
    return { teamId: repo.teamId };
  }
  if (led.length === 1) {
    return { teamId: led[0] as string };
  }
  return {
    code: 'TEAM_REQUIRED',
    message: 'You lead several teams on this repository; pass teamId to choose which owns it',
    status: 400,
  };
}

/**
 * Resolve the template snapshot for a schedule: explicit override when set,
 * otherwise the repo team's default (same resolution as POST /work-requests).
 * Returns an error string when nothing resolvable is configured.
 *
 * `viewer` is the caller choosing the override. When set, the override must be
 * one they can see — a GLOBAL template or one of their teams' — the same rule
 * the template picker and POST /workflow-templates/:id/runs apply, so a guessed
 * id cannot schedule another team's workflow. It is null when the override is
 * the one already stored on the schedule, which was checked when it was set.
 */
async function resolveScheduleTemplate(
  prisma: Prisma,
  repo: { teamId: string },
  templateId: string | null,
  templateVersion: number | null,
  ticketId: string,
  viewer: { role: string; sub: string } | null
): Promise<{ templateId: string; templateVersion: number } | { error: string }> {
  if (templateId) {
    const tpl = await prisma.workflowTemplate.findFirst({
      where: {
        id: templateId,
        ...EXCLUDE_SYSTEM_TEMPLATES,
        ...(viewer && viewer.role !== 'ADMIN'
          ? { AND: [{ OR: [{ teamId: null }, { team: memberTeams(viewer) }] }] }
          : {}),
      },
    });
    if (!tpl) {
      return { error: `Template ${templateId} not found` };
    }
    const version = templateVersion ?? tpl.activeVersion;
    if (!version) {
      return { error: `Template ${templateId} has no active version` };
    }
    const versionRow = await prisma.workflowTemplateVersion.findUnique({
      where: { templateId_version: { templateId, version } },
    });
    if (!versionRow) {
      return { error: `Template ${templateId} has no version ${version}` };
    }
    return { templateId, templateVersion: version };
  }
  const resolved = await resolveDefaultTemplate(prisma, repo.teamId, ticketId);
  if (!resolved) {
    return { error: 'No default workflow template configured for this team' };
  }
  return { templateId: resolved.templateId, templateVersion: resolved.version };
}

interface ScheduleRowForSync {
  id: string;
  /** Whose identity every fire launches as — see `ScheduledWorkRequest.actsAsUserId`. */
  actsAsUserId: string | null;
  cronExpression: string;
  isActive: boolean;
  budgetTier: string;
  description: string;
  externalTicketPrefix: string;
  repoId: string;
  workRequestId: string | null;
  name: string;
}

/** Synthetic ticket ID for a schedule (static — schedule args can't vary per fire). */
function scheduleTicketId(prefix: string, scheduleRowId: string): string {
  return `${prefix}-SCHED-${scheduleRowId.slice(0, 8)}`;
}

/** Compose the static Temporal Schedule input from a schedule row. */
function buildScheduleInput(
  row: ScheduleRowForSync,
  template: { templateId: string; templateVersion: number },
  workRequestId: string
): WorkRequestScheduleInput {
  const request: RepoWorkRequest = {
    budgetTier: row.budgetTier as RepoWorkRequest['budgetTier'],
    description: row.description,
    externalTicketId: scheduleTicketId(row.externalTicketPrefix, row.id),
    // Fixed in the Temporal schedule's stored arguments, so every fire — cron
    // or by hand — launches as the user who last defined what the schedule
    // does, and nobody else. Absent (a schedule from before this existed, or
    // its author deleted) means no launcher: the platform credential.
    ...(row.actsAsUserId ? { launchedById: row.actsAsUserId } : {}),
    repoId: row.repoId,
    requestPayload: JSON.stringify({
      name: row.name,
      scheduledWorkRequestId: row.id,
      source: 'schedule',
    }),
    workRequestId,
  };
  return {
    cronExpression: row.cronExpression,
    paused: !row.isActive,
    request,
    scheduleRowId: row.id,
    templateId: template.templateId,
    templateVersion: template.templateVersion,
  };
}

const scheduleInclude = {
  actsAsUser: { select: { email: true, id: true, name: true } },
  createdBy: { select: { email: true, id: true, name: true } },
  repository: { select: { id: true, organizationName: true, repoName: true } },
  team: { select: { id: true, name: true, slug: true } },
  template: { select: { id: true, name: true } },
} as const;

/**
 * `scheduleInclude` plus what `canManage` reads: the owning team, the shared
 * teams and the caller's own membership in each. Used by the list, so every row
 * can say whether this caller may act on it.
 */
const scheduleListInclude = (userId: string) =>
  ({
    ...scheduleInclude,
    repository: {
      select: {
        id: true,
        organizationName: true,
        repoName: true,
        shares: {
          select: {
            team: {
              select: { memberships: { select: { role: true, userId: true }, where: { userId } } },
            },
            teamId: true,
          },
        },
        team: {
          select: { memberships: { select: { role: true, userId: true }, where: { userId } } },
        },
        teamId: true,
      },
    },
  }) as const;

/**
 * Whether the caller may edit, fire, pause or delete a listed schedule — the
 * same `canManage` rule the write routes apply, so the dashboard can offer only
 * what will not 403. A row without the membership data answers ADMIN-only.
 */
// biome-ignore lint/suspicious/noExplicitAny: row shape comes from scheduleListInclude
function rowCanManage(user: { role: string }, row: any): boolean {
  if (user.role === 'ADMIN') {
    return true;
  }
  const repo = row.repository;
  if (!repo?.team || !Array.isArray(repo.shares)) {
    return false;
  }
  return canManage(user, repo as unknown as RepoWithMembership, { teamId: row.teamId ?? null });
}

// biome-ignore lint/suspicious/noExplicitAny: row shape comes from the include above; serialized explicitly
function serializeSchedule(row: any, schedule: unknown, mayManage: boolean) {
  return {
    /** Whose own GitHub token fires may use — the last author of its contents. */
    actsAs: row.actsAsUser ?? null,
    budgetTier: row.budgetTier,
    /** Whether the caller may edit, fire, pause or delete this schedule. */
    canManage: mayManage,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    cronExpression: row.cronExpression,
    description: row.description,
    externalTicketId: scheduleTicketId(row.externalTicketPrefix, row.id),
    externalTicketPrefix: row.externalTicketPrefix,
    id: row.id,
    isActive: row.isActive,
    lastFiredAt: row.lastFiredAt,
    name: row.name,
    repository: {
      id: row.repository.id,
      organizationName: row.repository.organizationName,
      repoName: row.repository.repoName,
    },
    schedule,
    /** Owning team; null means its team was deleted. */
    team: row.team ?? null,
    template: row.template,
    templateVersion: row.templateVersion,
    updatedAt: row.updatedAt,
    workRequestId: row.workRequestId,
  };
}

/** Thrown inside a transaction to roll it back when the row moved under the request. */
class ScheduleConflictError extends Error {}

const CONFLICT_BODY = {
  error: {
    code: 'SCHEDULE_CONFLICT',
    message: 'The schedule was changed by someone else while this request ran; reload and retry',
  },
} as const;

/** How many times a PATCH re-takes its decision on a re-read row before giving up. */
const MAX_PATCH_ATTEMPTS = 3;

/** Returned by one PATCH attempt whose conditional write lost to another writer. */
const PATCH_LOST_RACE = Symbol('patch-lost-race');

/** A PATCH attempt that wrote the row. */
class PatchSaved {
  constructor(readonly row: { id: string; isActive: boolean }) {}
}

/**
 * Columns a concurrent write may change without invalidating a decision taken
 * on the row as read: who the schedule acts as (the retried decision re-derives
 * it and re-runs the launch gate against the re-read row), its
 * optimistic-concurrency token and timestamps, and fire bookkeeping.
 */
const ORTHOGONAL_COLUMNS = new Set([
  'actsAsUserId',
  'lastFiredAt',
  'nextFireAt',
  'updatedAt',
  'version',
]);

/**
 * Whether `after` differs from `before` only in columns that do not feed a
 * PATCH's decision. Anything else (a pause, a rename, a new template or cron,
 * a team move, an unshare-deactivation) was a deliberate change the caller never
 * saw, so the caller gets a conflict instead of silently overwriting it.
 */
function changedOnlyOrthogonally(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): boolean {
  const same = (x: unknown, y: unknown) =>
    x instanceof Date && y instanceof Date ? x.getTime() === y.getTime() : x === y;
  return Object.keys(after).every((k) => ORTHOGONAL_COLUMNS.has(k) || same(before[k], after[k]));
}

/**
 * Put the Temporal schedule back in step with the row as it stands NOW. Used
 * wherever a request had already synced Temporal and then lost the race for the
 * row (or failed writing it): the row is what the next request and the worker's
 * checks see, so Temporal is made to match it rather than a snapshot read
 * earlier. Best-effort; returns whether Temporal now matches.
 */
async function resyncTemporalFromRow(
  fastify: FastifyInstance,
  scheduleId: string,
  log: FastifyRequest['log']
): Promise<boolean> {
  try {
    const current = await fastify.prisma.scheduledWorkRequest.findUnique({
      where: { id: scheduleId },
    });
    if (!current?.workRequestId) {
      return false;
    }
    const synced = await fastify.prisma.runInput.findUnique({
      select: { templateId: true, templateVersion: true },
      where: { id: current.workRequestId },
    });
    if (!(synced?.templateId && synced.templateVersion)) {
      return false;
    }
    await fastify.temporal.syncWorkRequestSchedule(
      buildScheduleInput(
        current,
        { templateId: synced.templateId, templateVersion: synced.templateVersion },
        current.workRequestId
      )
    );
    return true;
  } catch (err) {
    log.error(
      { err, scheduleId },
      'could not re-sync the Temporal schedule to its row; the next successful edit repairs it'
    );
    return false;
  }
}

/**
 * Pause the schedules on `repoId` whose owning team no longer has a claim on it
 * (neither the repository's owning team nor a team it is shared with), after a
 * share was removed or the repository moved. A null-team schedule (its team was
 * deleted) has no claim either, so it is paused too.
 *
 * The row is deactivated first (a schedule must not stay "active" in the
 * dashboard) and each deactivation is audited on its own, against the schedule
 * (`actorId` is whoever changed the share or moved the repository), then the
 * Temporal schedule is paused. Nothing here fails the
 * caller, per row: the share change has already committed, the list view shows
 * the live Temporal state, and the worker refuses a fire of an inactive row and
 * re-checks the author's access on every one.
 */
export async function deactivateSchedulesOutsideTeams(
  fastify: FastifyInstance,
  repoId: string,
  log: FastifyRequest['log'],
  actorId: string | null = null
): Promise<number> {
  const repo = await fastify.prisma.connection.findUnique({
    select: { shares: { select: { teamId: true } }, teamId: true },
    where: { id: repoId },
  });
  if (!repo) {
    return 0;
  }
  const allowed = [repo.teamId, ...repo.shares.map((s) => s.teamId)];
  // Every team but the ones named: a cross-tenant predicate by construction,
  // bounded to one repository.
  const stranded = await runUnscoped(
    "schedules of the teams that no longer have a claim on one repository, by definition not the owner's or a sharer's",
    ['ScheduledWorkRequest'],
    () =>
      fastify.prisma.scheduledWorkRequest.findMany({
        where: {
          isActive: true,
          OR: [{ teamId: null }, { teamId: { notIn: allowed } }],
          repoId,
        },
      })
  );
  for (const row of stranded) {
    try {
      // Conditional on the team it was read with: a row someone has since moved
      // to a team that does have a claim is left alone.
      const deactivated = await fastify.prisma.scheduledWorkRequest.updateMany({
        data: { isActive: false, version: { increment: 1 } },
        where: { id: row.id, isActive: true, teamId: row.teamId },
      });
      if (deactivated.count > 0) {
        // Recorded right after the write, and only when this call made the
        // change: a row someone else already moved is not ours to report. A
        // failed audit write must not skip the pause that follows, but it is
        // logged, never silent.
        try {
          await fastify.prisma.configAuditLog.create({
            data: {
              action: 'UPDATE',
              actorId,
              afterJson: {
                event: 'schedule-deactivated',
                isActive: false,
                reason: 'team lost its claim on the repository',
              },
              beforeJson: { isActive: true, repoId, teamId: row.teamId },
              entityId: row.id,
              entityType: 'ScheduledWorkRequest',
            },
          });
        } catch (auditErr) {
          log.error(
            { err: auditErr, scheduleId: row.id },
            'deactivated the schedule of an unshared team but could not audit it'
          );
        }
      }
      // Sync from the row as it stands now, so a takeover that landed meanwhile
      // keeps its launcher and a re-activation is not paused behind its back.
      const current = await fastify.prisma.scheduledWorkRequest.findUnique({
        where: { id: row.id },
      });
      const synced = current?.workRequestId
        ? await fastify.prisma.runInput.findUnique({
            select: { templateId: true, templateVersion: true },
            where: { id: current.workRequestId },
          })
        : null;
      if (!(current?.workRequestId && synced?.templateId && synced.templateVersion)) {
        log.warn(
          { scheduleId: row.id },
          'deactivated the schedule of an unshared team but skipped pausing its Temporal schedule: no standing work request to build it from'
        );
        continue;
      }
      await fastify.temporal.syncWorkRequestSchedule(
        buildScheduleInput(
          current,
          { templateId: synced.templateId, templateVersion: synced.templateVersion },
          current.workRequestId
        )
      );
    } catch (err) {
      log.error(
        { err, scheduleId: row.id },
        'could not deactivate or pause the schedule of an unshared team'
      );
    }
  }
  return stranded.length;
}

export const scheduledWorkRequestRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // List schedules. Admins see everything; everyone else sees schedules for
  // repos on teams they belong to. Live next/last-fire info comes from the
  // Temporal Schedule (best-effort — DB columns are only bookkeeping).
  app.get('/', { onRequest: requireAuth({ requiredRole: 'ENGINEER' }) }, async (request) => {
    const user = requireUser(request);
    // A schedule is visible through the repository it runs on (owner or shared
    // team), not through its own team: the owner sees every team's schedules on
    // its repository, so the scope is the repository relation.
    const rows = await runUnscoped(
      'schedules are scoped through the repository the caller can reach; an admin sees all',
      ['ScheduledWorkRequest'],
      () =>
        fastify.prisma.scheduledWorkRequest.findMany({
          include: scheduleListInclude(user.sub),
          orderBy: { createdAt: 'desc' },
          where:
            user.role === 'ADMIN'
              ? {}
              : { repository: reachableConnections(user, request.repoAccessGate) },
        })
    );
    const statuses = await Promise.all(
      rows.map(async (row) => {
        try {
          return await fastify.temporal.getWorkRequestScheduleStatus(row.id);
        } catch {
          return { exists: false, lastRunAt: null, nextRunAt: null, paused: false };
        }
      })
    );
    return {
      data: rows.map((row, i) => serializeSchedule(row, statuses[i], rowCanManage(user, row))),
    };
  });

  app.post(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { body: CreateScheduleSchema },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const body = request.body;

      const repo = await loadRepoWithMembership(fastify.prisma, body.repoId, user.sub);
      if (!repo?.isActive) {
        return reply.status(404).send({
          error: {
            code: 'REPO_NOT_FOUND',
            message: `Repository ${body.repoId} not found or inactive`,
          },
        });
      }
      if (!canCreate(user, repo)) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message:
              'Requires ADMIN role, or LEAD membership on the repository team or a team it is shared with',
          },
        });
      }
      const owner = resolveCreateTeam(user, repo, body.teamId);
      if ('status' in owner) {
        return reply
          .status(owner.status)
          .send({ error: { code: owner.code, message: owner.message } });
      }
      if (!(await passesLaunchAuthorization(fastify, request, user, repo, reply, 'caller'))) {
        return;
      }

      // IDs generated upfront: the synthetic ticket / branch / Temporal
      // schedule ID all derive from the schedule row ID.
      const scheduleId = crypto.randomUUID();
      const workRequestId = crypto.randomUUID();
      const ticketId = scheduleTicketId(body.externalTicketPrefix, scheduleId);

      const template = await resolveScheduleTemplate(
        fastify.prisma,
        repo,
        body.templateId ?? null,
        body.templateVersion ?? null,
        ticketId,
        user
      );
      if ('error' in template) {
        return reply
          .status(422)
          .send({ error: { code: 'TEMPLATE_NOT_RESOLVABLE', message: template.error } });
      }

      const { branchPrefix } = await resolveWorkflowDefaults();
      const branch = generateBranchName(ticketId, branchPrefix);

      // Standing WorkRequest — every fire's WorkflowRun links to it, so
      // scheduled runs are attributable in /runs and the work-request list.
      // All three rows land in one transaction: a failure on the second or
      // third create must not leave an orphan RunInput/ActiveWorkflow behind.
      const runInputCreate = fastify.prisma.runInput.create({
        data: {
          description: body.description,
          externalTicketId: ticketId,
          id: workRequestId,
          requestedById: user.sub,
          requestPayload: JSON.stringify({
            name: body.name,
            scheduledWorkRequestId: scheduleId,
            source: 'schedule',
          }),
          templateId: template.templateId,
          templateVersion: template.templateVersion,
          // `<prefix>-SCHED-<id>` is generated from the schedule, not a tracker ticket.
          ticketIsSynthetic: true,
        },
      });

      // Anchor ActiveWorkflow row. Its temporalWorkflowId is the schedule's
      // BASE workflow ID, which no real fire uses (fires get a timestamp
      // suffix), so it never collides. It exists so worker activities that
      // join workRequestId → ActiveWorkflow (PR reuse, budget display) find a
      // row carrying the repo / branch / budget tier.
      const activeWorkflowCreate = fastify.prisma.activeWorkflow.create({
        data: {
          assignedBranch: branch,
          budgetTier: body.budgetTier,
          currentStatus: 'SCHEDULED',
          repoId: repo.id,
          temporalWorkflowId: `sched-${scheduleId}`,
          workRequestId,
        },
      });

      const scheduleCreate = fastify.prisma.scheduledWorkRequest.create({
        data: {
          actsAsUserId: user.sub,
          budgetTier: body.budgetTier,
          createdById: user.sub,
          cronExpression: body.cronExpression,
          description: body.description,
          externalTicketPrefix: body.externalTicketPrefix,
          id: scheduleId,
          isActive: body.isActive,
          name: body.name,
          repoId: repo.id,
          teamId: owner.teamId,
          templateId: body.templateId ?? null,
          templateVersion: body.templateId ? template.templateVersion : null,
          workRequestId,
        },
        include: scheduleInclude,
      });
      const [, , row] = await fastify.prisma.$transaction([
        runInputCreate,
        activeWorkflowCreate,
        scheduleCreate,
      ]);

      try {
        await fastify.temporal.syncWorkRequestSchedule(
          buildScheduleInput(row, template, workRequestId)
        );
      } catch (err) {
        // Roll back the rows so a Temporal outage doesn't leave a schedule
        // row with no backing Temporal Schedule (the inverse — a zombie
        // schedule firing against missing rows — would be much worse).
        request.log.error({ err }, 'failed to create Temporal schedule; rolling back');
        await fastify.prisma.$transaction([
          fastify.prisma.scheduledWorkRequest.delete({ where: { id: scheduleId } }),
          fastify.prisma.activeWorkflow.deleteMany({
            where: { temporalWorkflowId: `sched-${scheduleId}` },
          }),
          fastify.prisma.runInput.delete({ where: { id: workRequestId } }),
        ]);
        return reply.status(502).send({
          error: { code: 'SCHEDULE_SYNC_FAILED', message: 'Could not create Temporal schedule' },
        });
      }

      const status = await fastify.temporal.getWorkRequestScheduleStatus(scheduleId).catch(() => ({
        exists: true,
        lastRunAt: null,
        nextRunAt: null,
        paused: !body.isActive,
      }));
      return reply.status(201).send({ data: serializeSchedule(row, status, true) });
    }
  );

  app.patch(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { body: UpdateScheduleSchema, params: IdParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const initial = await fastify.prisma.scheduledWorkRequest.findUnique({
        where: { id: request.params.id },
      });
      if (!initial) {
        return reply.status(404).send({
          error: { code: 'SCHEDULE_NOT_FOUND', message: 'Scheduled work request not found' },
        });
      }
      // One attempt: decide on `existing`, sync Temporal, write conditionally.
      const patchOnce = async (existing: NonNullable<typeof initial>) => {
        const repo = await loadRepoWithMembership(fastify.prisma, existing.repoId, user.sub);
        if (!repo) {
          return reply.status(404).send({
            error: { code: 'REPO_NOT_FOUND', message: 'Repository not found' },
          });
        }
        if (!canManage(user, repo, existing)) {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: FORBIDDEN_MESSAGE },
          });
        }

        if (!existing.workRequestId) {
          // Standing WorkRequest was deleted out-of-band — the schedule can no
          // longer fire safely (RunnableWorkflow would FK-fail). Recreate it.
          return reply.status(409).send({
            error: {
              code: 'SCHEDULE_ORPHANED',
              message: 'Standing work request is missing; delete and recreate this schedule',
            },
          });
        }

        const body = request.body;
        const workRequestId = existing.workRequestId;
        const nextIsActive = body.isActive ?? existing.isActive;

        // `templateId: null` clears the override (→ team default); omitted keeps it.
        const nextTemplateId =
          body.templateId === undefined ? existing.templateId : body.templateId;
        const nextTemplateVersion =
          body.templateId === undefined && body.templateVersion === undefined
            ? existing.templateVersion
            : (body.templateVersion ?? null);

        const ticketId = scheduleTicketId(existing.externalTicketPrefix, existing.id);
        const template = await resolveScheduleTemplate(
          fastify.prisma,
          repo,
          nextTemplateId,
          nextTemplateVersion,
          ticketId,
          // Only a newly chosen override is checked against the caller; the stored
          // one was checked by whoever set it.
          nextTemplateId !== existing.templateId ? user : null
        );
        if ('error' in template) {
          return reply
            .status(422)
            .send({ error: { code: 'TEMPLATE_NOT_RESOLVABLE', message: template.error } });
        }

        // Whoever changes what the schedule does, how often it does it, how much it
        // may spend, or switches it back on, becomes who it runs as. Without this
        // a lead could rewrite — or revive, or speed up — another person's
        // schedule and have it run with that person's own GitHub token. Pausing
        // and renaming do not rebind: they cannot cause anything to run.
        // What actually ran last time is the template synced to Temporal, which
        // the standing run input records. A schedule on the team default stores no
        // template of its own, so comparing stored columns would miss a new team
        // default — or a new active version of it — being picked up by this edit.
        const lastSynced = await fastify.prisma.runInput.findUnique({
          select: { templateId: true, templateVersion: true },
          where: { id: workRequestId },
        });
        const rebinds =
          (body.description !== undefined && body.description !== existing.description) ||
          nextTemplateId !== existing.templateId ||
          nextTemplateVersion !== existing.templateVersion ||
          template.templateId !== lastSynced?.templateId ||
          template.templateVersion !== lastSynced?.templateVersion ||
          (body.cronExpression !== undefined && body.cronExpression !== existing.cronExpression) ||
          (body.budgetTier !== undefined && body.budgetTier !== existing.budgetTier) ||
          (body.isActive === true && !existing.isActive);
        const takesOver = rebinds && user.sub !== existing.actsAsUserId;
        // Reviving a schedule whose team has lost its claim on the repository (it
        // was unshared, moved, or deleted) would leave it stranded: the next share
        // change re-pauses it. Only the owning team's lead or an ADMIN can manage
        // such a schedule at all, so the repository's owning team adopts it.
        const revives = body.isActive === true && !existing.isActive;
        const movesTeam =
          revives &&
          repo.teamId !== existing.teamId &&
          !repo.shares.some((s) => s.teamId === existing.teamId);

        // Becoming who it runs as is a launch decision about the editor, taken
        // before anything is written — the same one creating a schedule takes. It
        // is also taken by the CURRENT acting user when the result will run: an
        // owner who has since lost access can pause their schedule but cannot
        // revive or speed it up, which would let a standing instruction outlive
        // the access that justified it. Re-timing an active schedule to every
        // minute is a way to spend more, so it counts.
        if (rebinds && (takesOver || nextIsActive)) {
          if (nextIsActive && !repo.isActive) {
            return reply.status(409).send({
              error: { code: 'REPO_INACTIVE', message: 'Repository is no longer active' },
            });
          }
          if (!(await passesLaunchAuthorization(fastify, request, user, repo, reply, 'caller'))) {
            return;
          }
        }

        const next: ScheduleRowForSync = {
          actsAsUserId: rebinds ? user.sub : existing.actsAsUserId,
          budgetTier: body.budgetTier ?? existing.budgetTier,
          cronExpression: body.cronExpression ?? existing.cronExpression,
          description: body.description ?? existing.description,
          externalTicketPrefix: existing.externalTicketPrefix,
          id: existing.id,
          isActive: nextIsActive,
          name: body.name ?? existing.name,
          repoId: existing.repoId,
          workRequestId,
        };

        // Temporal first, then the rows. The schedule is what actually fires, so
        // a failed sync must leave the stored row describing the schedule that is
        // really there — updating the row first and then failing the sync left the
        // dashboard showing a schedule Temporal never received.
        try {
          await fastify.temporal.syncWorkRequestSchedule(
            buildScheduleInput(next, template, workRequestId)
          );
        } catch (err) {
          request.log.error({ err }, 'failed to sync Temporal schedule after update');
          return reply.status(502).send({
            error: { code: 'SCHEDULE_SYNC_FAILED', message: 'Could not update Temporal schedule' },
          });
        }

        // The row writes are conditional on the state this request read, so an
        // edit, a fire-by-hand takeover or an unshare-deactivation that landed
        // meanwhile is a conflict, never silently overwritten. The transaction is
        // interactive so the count can be checked before the standing request and
        // the audit row are written.
        let row: Awaited<ReturnType<typeof fastify.prisma.scheduledWorkRequest.findUniqueOrThrow>>;
        try {
          row = await fastify.prisma.$transaction(async (tx) => {
            const claimed = await tx.scheduledWorkRequest.updateMany({
              data: {
                ...(body.budgetTier !== undefined ? { budgetTier: body.budgetTier } : {}),
                ...(body.cronExpression !== undefined
                  ? { cronExpression: body.cronExpression }
                  : {}),
                ...(body.description !== undefined ? { description: body.description } : {}),
                ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
                ...(body.name !== undefined ? { name: body.name } : {}),
                ...(rebinds ? { actsAsUserId: user.sub } : {}),
                ...(movesTeam ? { teamId: repo.teamId } : {}),
                templateId: nextTemplateId,
                templateVersion: nextTemplateId ? template.templateVersion : null,
                version: { increment: 1 },
              },
              where: {
                actsAsUserId: existing.actsAsUserId,
                id: existing.id,
                isActive: existing.isActive,
                teamId: existing.teamId,
                version: existing.version,
              },
            });
            if (claimed.count === 0) {
              throw new ScheduleConflictError();
            }
            // Keep the standing WorkRequest's description/template snapshot in
            // step so the /runs attribution stays truthful.
            await tx.runInput.update({
              data: {
                description: next.description,
                templateId: template.templateId,
                templateVersion: template.templateVersion,
              },
              where: { id: workRequestId },
            });
            // Taking a schedule over changes whose identity every later fire runs
            // as, and whose access it is checked against — so the transfer is
            // recorded, never silent.
            if ((rebinds && existing.actsAsUserId !== user.sub) || movesTeam) {
              await tx.configAuditLog.create({
                data: {
                  action: 'UPDATE',
                  actorId: user.sub,
                  afterJson: {
                    actsAsUserId: user.sub,
                    event: 'acts-as-changed',
                    ...(movesTeam ? { teamId: repo.teamId } : {}),
                  },
                  beforeJson: {
                    actsAsUserId: existing.actsAsUserId,
                    ...(movesTeam ? { teamId: existing.teamId } : {}),
                  },
                  entityId: existing.id,
                  entityType: 'ScheduledWorkRequest',
                },
              });
            }
            return tx.scheduledWorkRequest.findUniqueOrThrow({
              include: scheduleInclude,
              where: { id: existing.id },
            });
          });
        } catch (err) {
          if (err instanceof ScheduleConflictError) {
            // The caller decides whether to retry on the re-read row or to give up
            // (and only then put Temporal back).
            return PATCH_LOST_RACE;
          }
          await resyncTemporalFromRow(fastify, existing.id, request.log);
          throw err;
        }
        return new PatchSaved(row);
      };

      // A write that lost to another writer is retried on the re-read row, a
      // bounded number of times, when what changed does not touch what this
      // request decided on (a fire-by-hand takeover, a fire's bookkeeping): the
      // decision, launch gate included, is taken again on the row as it now is.
      // Anything else (a pause, an edit, an unshare-deactivation) is a conflict.
      let current = initial;
      // An attempt that lost its write had already synced Temporal. If a later
      // one ends without saving (a refusal, a conflict, a throw) before syncing
      // anew, Temporal would keep the lost edit while the row keeps the other
      // writer's state, so it is put back to the row on every such exit.
      let temporalMaybeAhead = false;
      const resyncIfAhead = async () => {
        if (temporalMaybeAhead) {
          await resyncTemporalFromRow(fastify, current.id, request.log);
        }
      };
      for (let attempt = 1; ; attempt++) {
        let outcome: Awaited<ReturnType<typeof patchOnce>>;
        try {
          outcome = await patchOnce(current);
        } catch (err) {
          await resyncIfAhead();
          throw err;
        }
        if (outcome === PATCH_LOST_RACE) {
          temporalMaybeAhead = true;
          const fresh = await fastify.prisma.scheduledWorkRequest.findUnique({
            where: { id: current.id },
          });
          if (
            !fresh ||
            fresh.version === current.version ||
            attempt >= MAX_PATCH_ATTEMPTS ||
            !changedOnlyOrthogonally(current, fresh)
          ) {
            // Temporal was synced for a row that did not take it; make it match
            // the row as it is now. Best-effort: if this fails too, it is
            // logged, and the worker refuses fires whose Temporal launcher no
            // longer matches the row until it is re-saved.
            await resyncTemporalFromRow(fastify, current.id, request.log);
            return reply.status(409).send(CONFLICT_BODY);
          }
          current = fresh;
          continue;
        }
        if (!(outcome instanceof PatchSaved)) {
          await resyncIfAhead();
          return outcome;
        }
        const { row } = outcome;
        const status = await fastify.temporal
          .getWorkRequestScheduleStatus(row.id)
          .catch(() => ({ exists: true, lastRunAt: null, nextRunAt: null, paused: !row.isActive }));
        return reply.send({ data: serializeSchedule(row, status, true) });
      }
    }
  );

  // Fire immediately — triggers the Temporal Schedule, which exercises the
  // exact same RunnableWorkflow path as a cron fire (SKIP overlap: dropped if
  // a previous fire is still running).
  app.post(
    '/:id/fire',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: IdParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const existing = await fastify.prisma.scheduledWorkRequest.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply.status(404).send({
          error: { code: 'SCHEDULE_NOT_FOUND', message: 'Scheduled work request not found' },
        });
      }
      const repo = await loadRepoWithMembership(fastify.prisma, existing.repoId, user.sub);
      if (!repo || !canManage(user, repo, existing)) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: FORBIDDEN_MESSAGE },
        });
      }
      // A paused schedule cannot be fired by hand: Temporal would accept the
      // trigger, but the worker refuses every fire of an inactive row, so the
      // request would answer 202 and always fail, after a takeover had already
      // changed whose identity it runs as. Refused before any of that.
      if (!existing.isActive) {
        return reply.status(409).send({
          error: {
            code: 'SCHEDULE_INACTIVE',
            message: 'The schedule is paused; resume it before firing it',
          },
        });
      }
      // Whoever causes a fire is who it runs as, the same rule as editing. The
      // firer is judged as themselves ('caller') whether they are the author or
      // about to become it, since either way their own saved token is what the
      // run uses.
      const takesOver = user.sub !== existing.actsAsUserId;
      if (takesOver && !repo.isActive) {
        return reply.status(409).send({
          error: { code: 'REPO_INACTIVE', message: 'Repository is no longer active' },
        });
      }
      if (!(await passesLaunchAuthorization(fastify, request, user, repo, reply, 'caller'))) {
        return;
      }

      // Taking the schedule over: Temporal's stored arguments carry the
      // launcher, so they are re-synced to the firer before anything fires.
      // Same order as PATCH: Temporal, then the (conditional) row; whichever
      // step fails puts Temporal back in step with the row as it now stands, so
      // the two never name different launchers.
      // The row's version as the takeover left it, for the revert's predicate.
      let claimedVersion: number | null = null;
      if (takesOver) {
        const workRequestId = existing.workRequestId;
        const synced = workRequestId
          ? await fastify.prisma.runInput.findUnique({
              select: { templateId: true, templateVersion: true },
              where: { id: workRequestId },
            })
          : null;
        if (!(workRequestId && synced?.templateId && synced.templateVersion)) {
          return reply.status(409).send({
            error: {
              code: 'SCHEDULE_ORPHANED',
              message: 'Standing work request is missing; delete and recreate this schedule',
            },
          });
        }
        const template = { templateId: synced.templateId, templateVersion: synced.templateVersion };
        try {
          await fastify.temporal.syncWorkRequestSchedule(
            buildScheduleInput({ ...existing, actsAsUserId: user.sub }, template, workRequestId)
          );
        } catch (err) {
          request.log.error({ err }, 'failed to re-bind Temporal schedule before fire');
          return reply.status(502).send({
            error: { code: 'SCHEDULE_SYNC_FAILED', message: 'Could not update Temporal schedule' },
          });
        }
        let claimed: number | null;
        try {
          claimed = await fastify.prisma.$transaction(async (tx) => {
            // Conditional on what was read: if the row changed meanwhile (an
            // edit, a pause, an unshare-deactivation) this takeover is stale.
            const result = await tx.scheduledWorkRequest.updateMany({
              data: { actsAsUserId: user.sub, version: { increment: 1 } },
              where: {
                actsAsUserId: existing.actsAsUserId,
                id: existing.id,
                isActive: existing.isActive,
                teamId: existing.teamId,
                version: existing.version,
              },
            });
            if (result.count === 0) {
              return null;
            }
            // Read inside the transaction: our own write holds the row lock, so
            // this is exactly the state a revert must find unchanged.
            const after = await tx.scheduledWorkRequest.findUnique({
              select: { version: true },
              where: { id: existing.id },
            });
            // A takeover is recorded, never silent.
            await tx.configAuditLog.create({
              data: {
                action: 'UPDATE',
                actorId: user.sub,
                afterJson: { actsAsUserId: user.sub, event: 'acts-as-changed' },
                beforeJson: { actsAsUserId: existing.actsAsUserId },
                entityId: existing.id,
                entityType: 'ScheduledWorkRequest',
              },
            });
            return after?.version ?? existing.version + 1;
          });
        } catch (err) {
          await resyncTemporalFromRow(fastify, existing.id, request.log);
          throw err;
        }
        claimedVersion = claimed;
        if (claimed === null) {
          // Temporal holds the firer for a row that did not take it; make it
          // match the row as it is now (which may be paused: never resurrect it).
          await resyncTemporalFromRow(fastify, existing.id, request.log);
          return reply.status(409).send(CONFLICT_BODY);
        }
      }

      try {
        await fastify.temporal.triggerWorkRequestSchedule(existing.id);
      } catch (err) {
        request.log.error({ err }, 'failed to trigger schedule');
        // Nothing ran, so the author keeps the schedule: a takeover that did not
        // fire anything is undone. The ROW is reverted first, and only if it is
        // still exactly as the takeover left it; Temporal is then synced from
        // the row as it now stands, so a deactivation or edit that landed
        // meanwhile is what Temporal follows, never a stale snapshot. If
        // Temporal cannot be brought to the row, it still holds the firer, so
        // the row keeps the firer too rather than leave the two naming
        // different people.
        if (claimedVersion !== null) {
          const takenVersion = claimedVersion;
          const audit = (event: string, extra: Record<string, unknown>) =>
            fastify.prisma.configAuditLog
              .create({
                data: {
                  action: 'UPDATE',
                  actorId: user.sub,
                  afterJson: { event, ...extra },
                  beforeJson: { actsAsUserId: user.sub },
                  entityId: existing.id,
                  entityType: 'ScheduledWorkRequest',
                },
              })
              .catch((auditErr: unknown) => {
                request.log.error({ err: auditErr, scheduleId: existing.id }, 'audit write failed');
              });
          const keepTakeover = (reason: string) =>
            audit('acts-as-takeover-kept', { actsAsUserId: user.sub, reason });
          let reverted: boolean | null;
          try {
            const result = await fastify.prisma.scheduledWorkRequest.updateMany({
              data: { actsAsUserId: existing.actsAsUserId, version: { increment: 1 } },
              where: {
                actsAsUserId: user.sub,
                id: existing.id,
                isActive: existing.isActive,
                teamId: existing.teamId,
                version: takenVersion,
              },
            });
            reverted = result.count > 0;
          } catch (revertErr) {
            request.log.error(
              { err: revertErr, scheduleId: existing.id },
              'fire failed and the schedule row could not be restored to its author'
            );
            reverted = null;
          }
          if (reverted === null) {
            // The row still names the firer: Temporal (which holds the firer)
            // is re-synced from it, and the takeover is recorded as kept.
            await resyncTemporalFromRow(fastify, existing.id, request.log);
            await keepTakeover(
              'the fire failed and the schedule row could not be restored to its author'
            );
          } else if (!reverted) {
            // Someone changed the row after the takeover; whatever they set is
            // the truth, so Temporal follows it (a pause stays a pause).
            await resyncTemporalFromRow(fastify, existing.id, request.log);
          } else if (await resyncTemporalFromRow(fastify, existing.id, request.log)) {
            await audit('acts-as-reverted', { actsAsUserId: existing.actsAsUserId });
          } else {
            // Temporal still holds the firer: put the row back on the firer so
            // the two agree, and say so.
            await fastify.prisma.scheduledWorkRequest
              .updateMany({
                data: { actsAsUserId: user.sub, version: { increment: 1 } },
                where: {
                  actsAsUserId: existing.actsAsUserId,
                  id: existing.id,
                  teamId: existing.teamId,
                },
              })
              .catch((err: unknown) => {
                request.log.error({ err, scheduleId: existing.id }, 'could not re-take the row');
              });
            await keepTakeover(
              'the fire failed and the Temporal schedule could not be restored to its author'
            );
          }
        }
        return reply.status(502).send({
          error: {
            code: 'SCHEDULE_TRIGGER_FAILED',
            message: 'Could not trigger Temporal schedule',
          },
        });
      }
      await fastify.prisma.scheduledWorkRequest.update({
        data: { lastFiredAt: new Date() },
        where: { id: existing.id },
      });
      return reply.status(202).send({ data: { triggered: true } });
    }
  );

  // Delete the schedule + its Temporal Schedule. The standing WorkRequest and
  // historical WorkflowRuns are intentionally kept — they're audit history.
  app.delete(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: IdParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const existing = await fastify.prisma.scheduledWorkRequest.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply.status(404).send({
          error: { code: 'SCHEDULE_NOT_FOUND', message: 'Scheduled work request not found' },
        });
      }
      const repo = await loadRepoWithMembership(fastify.prisma, existing.repoId, user.sub);
      if (!repo || !canManage(user, repo, existing)) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: FORBIDDEN_MESSAGE },
        });
      }

      // Temporal first (idempotent — only not-found is swallowed), then the
      // row. If Temporal is unreachable the row must survive: deleting it
      // would orphan a live schedule that keeps starting runs nothing can stop.
      try {
        await fastify.temporal.deleteWorkRequestSchedule(existing.id);
      } catch (err) {
        request.log.error({ err, scheduleId: existing.id }, 'failed to delete Temporal schedule');
        return reply.status(502).send({
          error: {
            code: 'SCHEDULE_SYNC_FAILED',
            message: 'Could not remove the Temporal schedule; the scheduled request was kept',
          },
        });
      }
      await fastify.prisma.scheduledWorkRequest.delete({ where: { id: existing.id } });
      return reply.send({ data: { deleted: true } });
    }
  );
};
