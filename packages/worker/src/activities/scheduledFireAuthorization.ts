/**
 * The launch decision, re-taken when a scheduled work request fires.
 *
 * A schedule's Temporal Schedule starts `RunnableWorkflow` directly — no
 * gateway route sits on the fire path. The gateway decides repository access,
 * org membership and the org's monthly cap when a schedule is created,
 * re-activated, re-timed or fired by hand, but an already-active schedule then
 * kept pushing on every cron tick after its owner lost access: removed from the
 * team, off the org, GitHub permission revoked, the org over its cap.
 *
 * This is that decision again, for the schedule's owner, at the moment of the
 * fire. It runs inside `createWorkflowRun` — the run's first activity — so the
 * workflow's command sequence is unchanged and replay is unaffected.
 *
 * A refusal is thrown as a non-retryable `ApplicationFailure`, not returned as
 * an `{ error }`: the workflow turns a returned error into a plain `Error`,
 * which Temporal treats as a workflow-TASK failure and retries forever. With
 * the Schedule's SKIP overlap policy a wedged fire would also swallow every
 * later one. An activity failure instead fails this one execution cleanly; the
 * next tick decides again, so restoring access resumes the schedule with no
 * other action.
 */
import { Prisma, type PrismaClient, type Role } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import type { AccessLog } from '@auto-swe/shared/lib/accessActor';
import {
  recordAutomationActivity,
  refusalKey,
  SCHEDULE_FIRE_SOURCE,
} from '@auto-swe/shared/lib/automationLedger';
import { orgMonthSpend, usdToCents } from '@auto-swe/shared/lib/billing';
import {
  decideRepoAccess,
  REPO_ACCESS_REFUSAL_MESSAGE,
} from '@auto-swe/shared/lib/repoAccessDecision';
import { resolveRepoAccessGateOrLastKnown } from '@auto-swe/shared/lib/repoAccessGate';
import { repoMembersSelect } from '@auto-swe/shared/lib/repoMembership';
import { liveInFlightExecution, type SettledLookup } from '@auto-swe/shared/lib/requestInFlight';
import { ApplicationFailure, log } from '@temporalio/activity';
import { workflowSettledStatus } from '../lib/agentRunSlots.js';

/** The Temporal failure type a refused fire carries. */
export const SCHEDULED_FIRE_REFUSED = 'SCHEDULED_FIRE_REFUSED';

/** How long an identical refusal is not re-audited, so a per-minute cron cannot flood the log. */
const REFUSAL_AUDIT_DEDUP_MS = 60 * 60 * 1000;

/** A schedule fire's workflow id: `sched-<row uuid>`, plus Temporal's per-fire suffix. */
export const SCHEDULE_FIRE_ID_RE =
  /^sched-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-|$)/i;

export type ScheduledFireRefusalReason =
  | 'schedule-missing'
  | 'acting-user-missing'
  | 'repository-inactive'
  | 'repository-source-changed'
  | 'schedule-team-unclaimed'
  | 'schedule-inactive'
  | 'launcher-out-of-sync'
  | 'gate-unreadable'
  | 'not-an-org-member'
  | 'org-budget-exceeded'
  | 'request-in-flight'
  | keyof typeof REPO_ACCESS_REFUSAL_MESSAGE;

export interface ScheduledFireRefusal {
  scheduleId: string;
  reason: ScheduledFireRefusalReason;
  message: string;
}

const ADVISORY_LOG: AccessLog = {
  warn: (obj, msg) => {
    try {
      log.warn(msg ?? 'repo access', obj as Record<string, unknown>);
    } catch (err) {
      console.warn('[scheduledFire] advisory log failed', err);
    }
  },
};

/**
 * Why this run, a fire of a scheduled work request, may not start — or null
 * when it may, or when it is not a scheduled fire at all.
 *
 * A fire is recognised by both halves: its work request is a schedule's
 * standing one AND its workflow id is that schedule's (`sched-<id>…`, with
 * Temporal's per-fire timestamp appended). The work request alone is not
 * enough — anything else that ever reuses the standing request was authorized
 * by whoever started it, not by the schedule's owner.
 */
export async function scheduledFireRefusal(
  db: PrismaClient,
  input: { workflowId: string; workRequestId?: string; launchedById?: string | null },
  settled: SettledLookup = workflowSettledStatus
): Promise<ScheduledFireRefusal | null> {
  if (!input.workRequestId || !input.workflowId.startsWith('sched-')) {
    return null;
  }
  const schedule = await db.scheduledWorkRequest.findFirst({
    select: {
      // Only an explicit acting user is authority; do not fall back to the schedule creator.
      actsAsUser: { select: { id: true, isActive: true, role: true } },
      id: true,
      // Deactivation (an unshared team, a moved repository) pauses the Temporal
      // schedule best-effort; the row is what the worker can still trust.
      isActive: true,
      repoId: true,
      // The team the schedule belongs to; checked against the repository's
      // current owner and sharers below.
      teamId: true,
      workRequest: {
        select: {
          knowledgeSourceKind: true,
          knowledgeSourceOrgId: true,
          knowledgeSourceRepoId: true,
          knowledgeSourceTeamId: true,
        },
      },
    },
    where: { workRequestId: input.workRequestId },
  });
  if (!schedule) {
    // A `sched-<uuid>` id is only ever minted by a schedule's own Temporal
    // action, so a fire whose row is gone — deleted with its repository by
    // cascade while the Temporal schedule lived on — is still a scheduled
    // fire. With no row there is no owner to check: refuse it rather than let
    // an orphaned schedule push unchecked.
    const orphan = SCHEDULE_FIRE_ID_RE.exec(input.workflowId);
    return orphan
      ? {
          message:
            'the schedule this fire belongs to no longer exists; delete its Temporal schedule',
          reason: 'schedule-missing',
          scheduleId: orphan[1] as string,
        }
      : null;
  }
  if (!input.workflowId.startsWith(`sched-${schedule.id}`)) {
    return null;
  }
  const refuse = (reason: ScheduledFireRefusalReason, message: string): ScheduledFireRefusal => ({
    message,
    reason,
    scheduleId: schedule.id,
  });

  // A deactivated schedule must not fire, whatever Temporal still says. The
  // gateway pauses the Temporal schedule when it deactivates a row, but that
  // call can fail; this is the backstop that makes the row authoritative.
  if (!schedule.isActive) {
    return refuse(
      'schedule-inactive',
      'the schedule is inactive; re-activate it (or delete its Temporal schedule) to resume'
    );
  }

  // Only the explicit launcher/acting user is a source authority. Legacy schedules without
  // `actsAsUserId` require an administrator or team lead to take them over before firing.
  const owner = schedule.actsAsUser;
  if (!owner?.isActive) {
    return refuse(
      'acting-user-missing',
      'the schedule has no active user to run as; an admin or team lead must re-activate it to take it over'
    );
  }
  // The identity this execution launched as comes from the Temporal schedule's
  // stored arguments; the authorization below judges the row's. They are written
  // together, but a failed sync (a takeover whose rollback could not reach
  // Temporal, a PATCH whose restore failed) leaves them naming different people,
  // and then a run would use one person's token on the strength of another's
  // access. Refuse until the schedule is saved again, which re-syncs both.
  const launcher = input.launchedById ?? null;
  if (launcher !== owner.id) {
    return refuse(
      'launcher-out-of-sync',
      "the schedule's stored identity is out of sync with its Temporal schedule; re-save the schedule (edit it or resume it) to repair it"
    );
  }
  const actor = { role: owner.role as Role, sub: owner.id };
  // The fire must use the schedule's explicit acting user; there is no creator fallback.
  const runIdentity = 'caller';

  const repo = await db.connection.findUnique({
    select: {
      githubApiUrl: true,
      githubUrl: true,
      id: true,
      installation: { select: { host: true, installationId: true, isActive: true } },
      isActive: true,
      organizationName: true,
      repoName: true,
      // Shared-team membership satisfies the launch decision, as at every launch.
      shares: {
        select: {
          ...repoMembersSelect({ userId: true }, { userId: owner.id }).shares.select,
          teamId: true,
        },
      },
      team: {
        select: {
          isActive: true,
          memberships: { select: { userId: true }, where: { userId: owner.id } },
          organization: { select: { isActive: true, monthlyBudgetUsdCents: true } },
          orgId: true,
        },
      },
      teamId: true,
      type: true,
    },
    where: { id: schedule.repoId },
  });
  if (!repo?.isActive || !repo.team.isActive || !repo.team.organization.isActive) {
    return refuse(
      'repository-inactive',
      'the repository, team, or organization is no longer active'
    );
  }

  const source = schedule.workRequest;
  if (
    source?.knowledgeSourceKind === 'REPOSITORY' &&
    (source.knowledgeSourceRepoId !== repo.id ||
      source.knowledgeSourceTeamId !== repo.teamId ||
      source.knowledgeSourceOrgId !== repo.team.orgId)
  ) {
    return refuse(
      'repository-source-changed',
      'the repository no longer matches the source identity saved when the schedule was created'
    );
  }

  // The schedule's team must still have a claim on the repository: its owning
  // team, or a team it is currently shared with. Deactivation on an unshare or
  // a move is best-effort, and a create can race an unshare, so the row alone
  // can name a team that no longer has one. A null `teamId` means the team was
  // deleted (the schedule-team migration backfilled every earlier row, and the
  // column is only nulled by `onDelete: SetNull`), so there is no team whose
  // claim could be checked: it is unclaimed too, until an ADMIN or the owning
  // team's lead re-saves it.
  const claimed =
    schedule.teamId != null &&
    (repo.teamId === schedule.teamId || repo.shares.some((s) => s.teamId === schedule.teamId));
  if (!claimed) {
    return refuse(
      'schedule-team-unclaimed',
      "the schedule's team no longer owns or shares the repository; an admin or the owning team's lead must re-assign or delete it"
    );
  }

  // Fail closed on an unreadable gate. The gateway can fall back to `off` for
  // an interactive request a person will retry; an unattended fire has nobody
  // to notice it pushed past an enforce policy it could not read.
  const gate = await resolveRepoAccessGateOrLastKnown();
  if (!gate) {
    return refuse('gate-unreadable', 'the repository access policy could not be read');
  }
  const verdict = await decideRepoAccess(
    db,
    actor,
    repo,
    gate,
    ADVISORY_LOG,
    'start-new-work',
    runIdentity
  );
  if (!verdict.allowed) {
    return refuse(verdict.reason, REPO_ACCESS_REFUSAL_MESSAGE[verdict.reason]);
  }

  if (actor.role !== 'ADMIN') {
    const membership = await db.organizationMembership.findUnique({
      where: { userId_orgId: { orgId: repo.team.orgId, userId: owner.id } },
    });
    if (!membership) {
      return refuse(
        'not-an-org-member',
        "the user the schedule runs as is no longer a member of the repository's organization"
      );
    }
  }

  const cap = repo.team.organization?.monthlyBudgetUsdCents ?? null;
  if (cap != null) {
    // The same spend the gateway's `isOrgOverBudget` reads, in-flight runs included.
    const { totalUsd } = await orgMonthSpend(db, repo.team.orgId);
    if (usdToCents(totalUsd) >= cap) {
      return refuse(
        'org-budget-exceeded',
        `the organization has exceeded its monthly budget cap of ${cap} USD cents`
      );
    }
  }

  // A re-run of the standing request pushes the schedule's one branch too. A
  // fire starting under it would adopt and re-link its pull request, so this
  // tick is skipped, as SKIP skips one that meets another fire; the next tick
  // asks again, and a re-run that is over (or whose row is stale: Temporal is
  // asked) no longer blocks. The re-run is refused the other way round in the
  // gateway.
  const running = await liveInFlightExecution(db, input.workRequestId, {
    ignoreFires: true,
    settled,
  });
  if (running) {
    return refuse(
      'request-in-flight',
      running.unconfirmed
        ? `could not confirm whether another run of this work request (${running.temporalWorkflowId}) has finished, because Temporal could not be asked; this fire is skipped and the next one asks again`
        : `another run of this work request is still in flight (${running.temporalWorkflowId}); this fire is skipped and the next one starts once it ends`
    );
  }
  return null;
}

/**
 * Record a refused fire where an operator will find it: the worker log on every
 * fire, and an audit row against the schedule at most once an hour per reason.
 *
 * Best-effort. The refusal itself is what protects the repository; a failure to
 * write its record must not turn into a retry of the fire.
 */
export async function recordScheduledFireRefusal(
  db: PrismaClient,
  refusal: ScheduledFireRefusal,
  workflowId: string
): Promise<void> {
  // A skipped fire is expected while a re-run is in flight, not a fault.
  const skipped = refusal.reason === 'request-in-flight';
  try {
    if (skipped) {
      log.info('scheduled fire skipped', { ...refusal, workflowId });
    } else {
      log.warn('scheduled fire refused', { ...refusal, workflowId });
    }
  } catch {
    console.warn('[scheduledFire] refused', refusal, workflowId);
  }
  // The schedule's decision history (docs/automations.md §5): one row an hour per reason.
  await recordAutomationActivity(
    db,
    {
      connectionId: null,
      facts: { reason: refusal.reason, workflowId },
      key: refusalKey(SCHEDULE_FIRE_SOURCE, refusal.scheduleId, refusal.reason, new Date()),
      outcome: REFUSAL_OUTCOME[refusal.reason] ?? 'SUPPRESSED_PRECONDITION',
      ownerId: refusal.scheduleId,
      reason: refusal.message,
      source: SCHEDULE_FIRE_SOURCE,
    },
    (err) => console.warn('[scheduledFire] could not record the refusal in the ledger:', err)
  );
  try {
    const recent = await db.configAuditLog.findFirst({
      select: { id: true },
      where: {
        afterJson: { equals: refusal.reason, path: ['reason'] },
        createdAt: { gte: new Date(Date.now() - REFUSAL_AUDIT_DEDUP_MS) },
        entityId: refusal.scheduleId,
        entityType: 'ScheduledWorkRequest',
      },
    });
    if (recent) {
      return;
    }
    await db.configAuditLog.create({
      data: {
        action: 'UPDATE',
        actorId: null,
        afterJson: {
          event: skipped ? 'fire-skipped' : 'fire-refused',
          message: refusal.message,
          reason: refusal.reason,
          workflowId,
        },
        entityId: refusal.scheduleId,
        entityType: 'ScheduledWorkRequest',
      },
    });
  } catch (err) {
    console.warn(
      `[scheduledFire] refused a fire of schedule ${refusal.scheduleId} but could not write the audit record:`,
      err
    );
  }
}

/** How a refused fire reads in the decision ledger; anything else is a precondition. */
const REFUSAL_OUTCOME: Partial<Record<ScheduledFireRefusalReason, string>> = {
  'org-budget-exceeded': 'SUPPRESSED_BUDGET',
  'request-in-flight': 'SUPPRESSED_IN_FLIGHT',
};

/**
 * Throw when this run is a scheduled fire its owner may no longer launch.
 * A no-op for every other run.
 */
export async function assertScheduledFireSourceSnapshot(
  tx: Prisma.TransactionClient,
  input: { workflowId: string; workRequestId?: string; launchedById?: string | null }
): Promise<void> {
  if (!input.workRequestId || !input.workflowId.startsWith('sched-')) {
    return;
  }
  const workflowScheduleId = SCHEDULE_FIRE_ID_RE.exec(input.workflowId)?.[1];
  if (!workflowScheduleId) {
    throw ApplicationFailure.nonRetryable(
      'scheduled fire id is malformed',
      SCHEDULED_FIRE_REFUSED,
      [
        {
          message: 'scheduled fire id is malformed',
          reason: 'schedule-missing',
          scheduleId: 'unknown',
        } satisfies ScheduledFireRefusal,
      ]
    );
  }
  // Lock the schedule before reading it so a concurrent reassignment, deactivation, or
  // identity takeover cannot change the authority between validation and WorkflowRun upsert.
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM scheduled_work_requests WHERE id = ${workflowScheduleId}::uuid FOR UPDATE`
  );
  const schedule = await tx.scheduledWorkRequest.findFirst({
    select: {
      actsAsUser: { select: { id: true } },
      id: true,
      isActive: true,
      repoId: true,
      teamId: true,
      workRequest: {
        select: {
          knowledgeSourceKind: true,
          knowledgeSourceOrgId: true,
          knowledgeSourceRepoId: true,
          knowledgeSourceTeamId: true,
        },
      },
    },
    where: { id: workflowScheduleId, workRequestId: input.workRequestId },
  });
  const scheduleId = schedule?.id ?? workflowScheduleId;
  const fail = (reason: ScheduledFireRefusalReason, message: string): never => {
    throw ApplicationFailure.nonRetryable(
      `scheduled fire ${schedule?.id ?? scheduleId ?? 'unknown'} refused: ${message}`,
      SCHEDULED_FIRE_REFUSED,
      [
        {
          message,
          reason,
          scheduleId: schedule?.id ?? scheduleId ?? 'unknown',
        } satisfies ScheduledFireRefusal,
      ]
    );
  };
  if (
    !schedule ||
    !scheduleId ||
    schedule.id !== scheduleId ||
    !input.workflowId.startsWith(`sched-${schedule.id}`) ||
    !schedule.isActive
  ) {
    return fail('schedule-inactive', 'the schedule is missing, mismatched, or inactive');
  }
  const actorId = input.launchedById ?? null;
  if (!actorId || schedule.actsAsUser?.id !== actorId) {
    return fail(
      'launcher-out-of-sync',
      'the explicit schedule launcher is missing or does not match the Temporal arguments'
    );
  }
  // Lock order: Schedule → exact launcher User → Connection → sorted Teams → sorted Organizations.
  // CLAUDE.md §7 exception: serialize source authority with user role/deactivation updates.
  const lockedUser = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM users WHERE id = ${actorId}::uuid FOR UPDATE`
  );
  const actor = lockedUser.length
    ? await tx.user.findUnique({
        select: { id: true, isActive: true, role: true },
        where: { id: actorId },
      })
    : null;
  if (!actor?.isActive) {
    return fail('acting-user-missing', 'the explicit schedule launcher is no longer active');
  }
  const owner = actor;

  // CLAUDE.md §7 exception: repository moves lock this row; Prisma cannot express SELECT FOR UPDATE.
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM connections WHERE id = ${schedule.repoId}::uuid FOR UPDATE
  `;
  if (locked.length === 0) {
    return fail('repository-inactive', 'the scheduled repository no longer exists');
  }
  const identity = await tx.connection.findUnique({
    select: {
      shares: { select: { teamId: true } },
      team: { select: { orgId: true } },
      teamId: true,
    },
    where: { id: schedule.repoId },
  });
  if (!identity) {
    return fail('repository-inactive', 'the scheduled repository no longer exists');
  }
  const sourceOrgId = schedule.workRequest?.knowledgeSourceOrgId;
  const teamIds = [
    ...new Set(
      [identity.teamId, ...identity.shares.map((share) => share.teamId), schedule.teamId].filter(
        (id): id is string => !!id
      )
    ),
  ].sort();
  for (const teamId of teamIds) {
    // CLAUDE.md §7 exception: serialize membership checks with team membership changes.
    await tx.$queryRaw(Prisma.sql`SELECT id FROM teams WHERE id = ${teamId}::uuid FOR UPDATE`);
  }
  const orgIds = [
    ...new Set([identity.team.orgId, sourceOrgId].filter((id): id is string => !!id)),
  ].sort();
  for (const orgId of orgIds) {
    // CLAUDE.md §7 exception: serialize org membership and activation checks with writers.
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`
    );
  }
  const repo = await tx.connection.findUnique({
    select: {
      id: true,
      isActive: true,
      shares: {
        select: {
          team: {
            select: {
              isActive: true,
              memberships: { select: { userId: true }, where: { userId: owner.id } },
            },
          },
          teamId: true,
        },
      },
      team: {
        select: {
          id: true,
          isActive: true,
          memberships: { select: { userId: true }, where: { userId: owner.id } },
          organization: { select: { isActive: true } },
          orgId: true,
        },
      },
      teamId: true,
      type: true,
    },
    where: { id: schedule.repoId },
  });
  if (!repo?.isActive || repo.type !== 'git_repo') {
    return fail('repository-inactive', 'the scheduled repository is no longer active');
  }
  // CLAUDE.md §7 exception: lock tenant rows and re-read their state after the provider check.
  const lockedTeam = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM teams WHERE id = ${repo.teamId}::uuid FOR UPDATE
  `;
  const lockedOrg = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM organizations WHERE id = ${repo.team.orgId}::uuid FOR UPDATE
  `;
  const currentTeam = await tx.team.findUnique({
    select: { id: true, isActive: true, orgId: true },
    where: { id: repo.teamId },
  });
  const currentOrg = await tx.organization.findUnique({
    select: { id: true, isActive: true },
    where: { id: repo.team.orgId },
  });
  if (
    lockedTeam.length === 0 ||
    lockedOrg.length === 0 ||
    !repo.team.isActive ||
    !repo.team.organization.isActive ||
    !currentTeam?.isActive ||
    currentTeam.orgId !== repo.team.orgId ||
    !currentOrg?.isActive
  ) {
    return fail('repository-inactive', 'the repository, team, or organization is no longer active');
  }
  if (
    schedule.workRequest?.knowledgeSourceKind === 'REPOSITORY' &&
    (schedule.workRequest.knowledgeSourceRepoId !== repo.id ||
      schedule.workRequest.knowledgeSourceTeamId !== repo.teamId ||
      schedule.workRequest.knowledgeSourceOrgId !== repo.team.orgId)
  ) {
    return fail(
      'repository-source-changed',
      'the current target no longer matches its saved source tuple'
    );
  }
  const claimExists =
    schedule.teamId === repo.teamId ||
    repo.shares.some((share) => share.teamId === schedule.teamId && share.team.isActive);
  if (!claimExists) {
    return fail(
      'schedule-team-unclaimed',
      'the schedule team no longer owns or shares the repository'
    );
  }

  if (owner.role !== 'ADMIN') {
    const hasMembership =
      repo.team.memberships.some((membership) => membership.userId === owner.id) ||
      repo.shares.some(
        (share) =>
          share.team.isActive &&
          share.team.memberships.some((membership) => membership.userId === owner.id)
      );
    if (!hasMembership) {
      return fail('not-a-team-member', 'the schedule owner is no longer a repository team member');
    }
    const orgMembership = await tx.organizationMembership.findUnique({
      select: { userId: true },
      where: { userId_orgId: { orgId: repo.team.orgId, userId: owner.id } },
    });
    if (!orgMembership) {
      return fail(
        'not-an-org-member',
        'the schedule owner is no longer a member of the repository organization'
      );
    }
  }
}

export async function assertScheduledFireAuthorized(input: {
  workflowId: string;
  workRequestId?: string;
  launchedById?: string | null;
}): Promise<void> {
  const refusal = await scheduledFireRefusal(prisma, input);
  if (!refusal) {
    return;
  }
  await recordScheduledFireRefusal(prisma, refusal, input.workflowId);
  throw ApplicationFailure.nonRetryable(
    `scheduled fire ${refusal.reason === 'request-in-flight' ? 'skipped' : 'refused'}: ${refusal.message}`,
    SCHEDULED_FIRE_REFUSED,
    { reason: refusal.reason, scheduleId: refusal.scheduleId }
  );
}
