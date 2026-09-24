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
import type { PrismaClient, Role } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import type { AccessLog } from '@auto-swe/shared/lib/accessActor';
import { currentYearMonth } from '@auto-swe/shared/lib/billing';
import {
  decideRepoAccess,
  REPO_ACCESS_REFUSAL_MESSAGE,
} from '@auto-swe/shared/lib/repoAccessDecision';
import { resolveRepoAccessGateOrLastKnown } from '@auto-swe/shared/lib/repoAccessGate';
import { ApplicationFailure, log } from '@temporalio/activity';

/** The Temporal failure type a refused fire carries. */
export const SCHEDULED_FIRE_REFUSED = 'SCHEDULED_FIRE_REFUSED';

/** How long an identical refusal is not re-audited, so a per-minute cron cannot flood the log. */
const REFUSAL_AUDIT_DEDUP_MS = 60 * 60 * 1000;

/** A schedule fire's workflow id: `sched-<row uuid>`, plus Temporal's per-fire suffix. */
const SCHEDULE_FIRE_ID_RE =
  /^sched-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-|$)/i;

export type ScheduledFireRefusalReason =
  | 'schedule-missing'
  | 'owner-missing'
  | 'repository-inactive'
  | 'gate-unreadable'
  | 'not-an-org-member'
  | 'org-budget-exceeded'
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
  input: { workflowId: string; workRequestId?: string }
): Promise<ScheduledFireRefusal | null> {
  if (!input.workRequestId || !input.workflowId.startsWith('sched-')) {
    return null;
  }
  const schedule = await db.scheduledWorkRequest.findFirst({
    select: {
      createdBy: { select: { id: true, isActive: true, role: true } },
      id: true,
      repoId: true,
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

  // Every fire acts for someone. A schedule whose owner was deleted or
  // deactivated has nobody whose access could be checked, and "no user to
  // check" is exactly the exemption this closes. An ADMIN re-activating or
  // editing it takes it over (the gateway records them as the owner).
  const owner = schedule.createdBy;
  if (!owner?.isActive) {
    return refuse(
      'owner-missing',
      'the schedule has no active owner; an admin or team lead must re-activate it to take it over'
    );
  }
  const actor = { role: owner.role as Role, sub: owner.id };

  const repo = await db.connection.findUnique({
    select: {
      githubApiUrl: true,
      id: true,
      installation: { select: { installationId: true, isActive: true } },
      isActive: true,
      organizationName: true,
      repoName: true,
      team: {
        select: {
          memberships: { select: { userId: true }, where: { userId: owner.id } },
          organization: { select: { monthlyBudgetUsdCents: true } },
          orgId: true,
        },
      },
      type: true,
    },
    where: { id: schedule.repoId },
  });
  if (!repo?.isActive) {
    return refuse('repository-inactive', 'the repository is no longer active');
  }

  // Fail closed on an unreadable gate. The gateway can fall back to `off` for
  // an interactive request a person will retry; an unattended fire has nobody
  // to notice it pushed past an enforce policy it could not read.
  const gate = await resolveRepoAccessGateOrLastKnown();
  if (!gate) {
    return refuse('gate-unreadable', 'the repository access policy could not be read');
  }
  const verdict = await decideRepoAccess(db, actor, repo, gate, ADVISORY_LOG);
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
        "the schedule's owner is no longer a member of the repository's organization"
      );
    }
  }

  const cap = repo.team.organization?.monthlyBudgetUsdCents ?? null;
  if (cap != null) {
    const usage = await db.orgMonthlyUsage.findUnique({
      where: { orgId_yearMonth: { orgId: repo.team.orgId, yearMonth: currentYearMonth() } },
    });
    // Same rounding as the gateway's `isOrgOverBudget`: micro-dollar precision
    // to cents with a small epsilon.
    const spentCents = Math.round(Number(usage?.costUsdAccrued ?? 0) * 100 + 1e-9);
    if (spentCents >= cap) {
      return refuse(
        'org-budget-exceeded',
        `the organization has exceeded its monthly budget cap of ${cap} USD cents`
      );
    }
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
  try {
    log.warn('scheduled fire refused', { ...refusal, workflowId });
  } catch {
    console.warn('[scheduledFire] refused', refusal, workflowId);
  }
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
          event: 'fire-refused',
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

/**
 * Throw when this run is a scheduled fire its owner may no longer launch.
 * A no-op for every other run.
 */
export async function assertScheduledFireAuthorized(input: {
  workflowId: string;
  workRequestId?: string;
}): Promise<void> {
  const refusal = await scheduledFireRefusal(prisma, input);
  if (!refusal) {
    return;
  }
  await recordScheduledFireRefusal(prisma, refusal, input.workflowId);
  throw ApplicationFailure.nonRetryable(
    `scheduled fire refused: ${refusal.message}`,
    SCHEDULED_FIRE_REFUSED,
    { reason: refusal.reason, scheduleId: refusal.scheduleId }
  );
}
