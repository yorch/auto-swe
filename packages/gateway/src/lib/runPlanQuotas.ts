import { resolveSettings } from '@auto-swe/shared/config';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyInstance } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';
import { writeAuditLog } from './auditLog.js';
import { type PlanRefusal, type RunPlanQuotaPolicy, refuse } from './runPlanService.js';

/**
 * Per-user limits on launch-time plan generation (`runPlans.*` registry settings), and the kill
 * switch.
 *
 * Every count is read from the database, so the limits hold across gateway replicas and restarts:
 *
 * - **Generation jobs per hour** count `ConfigAuditLog` rows of entity type `RunPlan` whose
 *   `afterJson.event` is {@link GENERATION_STARTED}, one written (in the same transaction as the
 *   check) when a job starts. A job that never produced a plan still counts, which is the point:
 *   the model calls were spent. The rows are the audit trail of who asked for a generation, and
 *   they carry ids and a mode, never the intent.
 * - **Pending plans** count `RunPlan` rows in `PENDING` that have not expired.
 * - **Template rankings per hour** count `afterJson.event` {@link ROUTE_REQUESTED} rows the same
 *   way.
 *
 * The check and the insert run under a transaction-scoped advisory lock keyed on the person, so
 * two replicas answering two requests at the same moment cannot both read "9 of 10" and both pass.
 */

export const GENERATION_STARTED = 'run_plan.generation_started';
export const ROUTE_REQUESTED = 'run_plan.route_requested';
const HOUR_MS = 3_600_000;

export interface PlanScope {
  teamId: string;
  orgId: string | null;
}

const settingsCtx = (scope: PlanScope) => ({
  ...(scope.orgId ? { orgId: scope.orgId } : {}),
  teamId: scope.teamId,
});

const disabled = (message: string): PlanRefusal => refuse(403, 'RUN_PLANS_DISABLED', message);

/** The kill switch, resolved at the team and organization the plan belongs to. */
export async function runPlansEnabled(scope: PlanScope): Promise<boolean> {
  const s = await resolveSettings(['runPlans.enabled'], settingsCtx(scope));
  return s['runPlans.enabled'];
}

async function pendingPlans(
  prisma: Pick<FastifyInstance['prisma'], 'runPlan'>,
  userId: string,
  now: Date
): Promise<number> {
  // A person's cap is across every team they plan for, so this count names the owner, not a team.
  return runUnscoped(
    'a person may hold only so many pending plans, across teams',
    ['RunPlan'],
    () =>
      prisma.runPlan.count({
        where: { expiresAt: { gt: now }, ownerUserId: userId, status: 'PENDING' },
      })
  );
}

type AuditClient = Pick<FastifyInstance['prisma'], 'configAuditLog' | 'runPlan' | '$executeRaw'>;

async function countRecent(
  tx: AuditClient,
  userId: string,
  event: string,
  since: Date
): Promise<number> {
  return tx.configAuditLog.count({
    where: {
      action: 'CREATE',
      actorId: userId,
      afterJson: { equals: event, path: ['event'] },
      createdAt: { gte: since },
      entityType: 'RunPlan',
    },
  });
}

export interface GenerationReservation {
  /** The audit row to delete if the job then fails to start, so a failed start costs no quota. */
  auditEntityId: string;
}

/**
 * Check the kill switch, the hourly generation limit and the pending-plan cap for a person, and
 * (when all pass) record the generation as started, atomically. Returns a refusal to send, or
 * `null` when the job may start.
 */
export async function reserveGenerationSlot(
  app: FastifyInstance,
  args: {
    user: JwtPayload;
    scope: PlanScope;
    /** The plan the job will produce (derived from the job id); the audit row's entity. */
    planId: string;
    jobId: string;
    repoId: string;
    mode: string;
    now?: Date;
  }
): Promise<PlanRefusal | null> {
  const s = await resolveSettings(
    ['runPlans.enabled', 'runPlans.createPerUserPerHour', 'runPlans.maxPendingPerUser'],
    settingsCtx(args.scope)
  );
  if (!s['runPlans.enabled']) {
    return disabled('Run plans are disabled');
  }
  const perHour = s['runPlans.createPerUserPerHour'];
  if (perHour === 0) {
    return disabled('Plan generation is disabled');
  }
  const now = args.now ?? new Date();
  return app.prisma.$transaction(async (tx) => {
    // CLAUDE.md §7 exception: serialize one person's quota check with its insert across replicas;
    // Prisma cannot express an advisory lock.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`run-plan-quota:${args.user.sub}`}, 0))`;
    if ((await pendingPlans(tx, args.user.sub, now)) >= s['runPlans.maxPendingPerUser']) {
      return refuse(
        429,
        'RUN_PLAN_PENDING_LIMIT',
        'You already hold the most plans waiting for approval; approve, reject or let one expire first'
      );
    }
    const recent = await countRecent(
      tx,
      args.user.sub,
      GENERATION_STARTED,
      new Date(now.getTime() - HOUR_MS)
    );
    if (recent >= perHour) {
      return refuse(
        429,
        'RUN_PLAN_RATE_LIMITED',
        'You have started the most plan generations allowed in an hour; try again later'
      );
    }
    await writeAuditLog(app, {
      action: 'CREATE',
      actor: args.user,
      after: {
        connectionId: args.repoId,
        event: GENERATION_STARTED,
        jobId: args.jobId,
        mode: args.mode,
        teamId: args.scope.teamId,
      },
      client: tx,
      entityId: args.planId,
      entityType: 'RunPlan',
    });
    return null;
  });
}

/** Take back a generation row whose job never started (Temporal refused the start). */
export async function releaseGenerationSlot(
  app: FastifyInstance,
  args: { userId: string; planId: string }
): Promise<void> {
  try {
    await app.prisma.configAuditLog.deleteMany({
      where: {
        action: 'CREATE',
        actorId: args.userId,
        afterJson: { equals: GENERATION_STARTED, path: ['event'] },
        entityId: args.planId,
        entityType: 'RunPlan',
      },
    });
  } catch (err) {
    app.log.warn({ err }, 'could not release a run plan generation slot');
  }
}

/** The kill switch and the hourly ranking limit; records the ranking when it passes. */
export async function reserveRouteSlot(
  app: FastifyInstance,
  args: { user: JwtPayload; scope: PlanScope; repoId: string; entityId: string; now?: Date }
): Promise<PlanRefusal | null> {
  const s = await resolveSettings(
    ['runPlans.enabled', 'runPlans.routePerUserPerHour'],
    settingsCtx(args.scope)
  );
  if (!s['runPlans.enabled']) {
    return disabled('Run plans are disabled');
  }
  const perHour = s['runPlans.routePerUserPerHour'];
  if (perHour === 0) {
    return refuse(403, 'RUN_PLANS_DISABLED', 'Ranking templates for a goal is disabled');
  }
  const now = args.now ?? new Date();
  return app.prisma.$transaction(async (tx) => {
    // CLAUDE.md §7 exception: same advisory lock as generation, a separate key, so a ranking never
    // waits for a generation check of the same person.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`run-plan-route-quota:${args.user.sub}`}, 0))`;
    const recent = await countRecent(
      tx,
      args.user.sub,
      ROUTE_REQUESTED,
      new Date(now.getTime() - HOUR_MS)
    );
    if (recent >= perHour) {
      return refuse(
        429,
        'RUN_PLAN_RATE_LIMITED',
        'You have ranked the most templates allowed in an hour; try again later'
      );
    }
    await writeAuditLog(app, {
      action: 'CREATE',
      actor: args.user,
      after: { connectionId: args.repoId, event: ROUTE_REQUESTED, teamId: args.scope.teamId },
      client: tx,
      entityId: args.entityId,
      entityType: 'RunPlan',
    });
    return null;
  });
}

/**
 * The service's quota hook. Creation re-checks the kill switch and the pending cap (the hourly
 * generation limit was spent when the job started, so it is not charged a second time at the
 * moment the finished job becomes a plan); approval re-checks the kill switch.
 */
export function createRunPlanQuotaPolicy(
  prisma: Pick<FastifyInstance['prisma'], 'runPlan' | 'team'>,
  opts: { now?: () => Date } = {}
): RunPlanQuotaPolicy {
  const nowOf = opts.now ?? (() => new Date());
  async function scopeOf(teamId: string): Promise<PlanScope> {
    const team = await prisma.team.findUnique({ select: { orgId: true }, where: { id: teamId } });
    return { orgId: team?.orgId ?? null, teamId };
  }
  return {
    async checkApprove({ teamId }) {
      return (await runPlansEnabled(await scopeOf(teamId)))
        ? null
        : disabled('Run plans are disabled');
    },
    async checkCreate({ teamId, userId }) {
      const scope = await scopeOf(teamId);
      const s = await resolveSettings(
        ['runPlans.enabled', 'runPlans.maxPendingPerUser'],
        settingsCtx(scope)
      );
      if (!s['runPlans.enabled']) {
        return disabled('Run plans are disabled');
      }
      if ((await pendingPlans(prisma, userId, nowOf())) >= s['runPlans.maxPendingPerUser']) {
        return refuse(
          429,
          'RUN_PLAN_PENDING_LIMIT',
          'You already hold the most plans waiting for approval; approve, reject or let one expire first'
        );
      }
      return null;
    },
  };
}
