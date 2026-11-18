import { resolveSettings } from '@auto-swe/shared/config';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyInstance } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';
import { writeAuditLog, writeAuditLogRow } from './auditLog.js';
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
 *
 * **A person's limit is the strictest one that applies to them.** The counts are per person, across
 * every team, so the limit they are compared with cannot depend on which team's repository the
 * request names (that would let a person raise it by choosing the repository). Each per-user limit
 * is resolved at the repository's scope and at every active team and organization the person belongs
 * to (at most {@link MAX_LIMIT_SCOPES}, in a fixed order), and the smallest value wins; a team or
 * organization that sets 0 disables the feature for every member.
 */

export const GENERATION_STARTED = 'run_plan.generation_started';
export const ROUTE_REQUESTED = 'run_plan.route_requested';
const HOUR_MS = 3_600_000;
/** Most scopes a person's limit is resolved at; the repository's own always counts first. */
export const MAX_LIMIT_SCOPES = 50;

export interface PlanScope {
  teamId: string;
  orgId: string | null;
}

const settingsCtx = (scope: PlanScope) => ({
  ...(scope.orgId ? { orgId: scope.orgId } : {}),
  teamId: scope.teamId,
});

/** A scope a limit is resolved at: a team (with its organization) or an organization alone. */
interface LimitScope {
  teamId: string | null;
  orgId: string | null;
}

const limitCtx = (scope: LimitScope) => ({
  ...(scope.orgId ? { orgId: scope.orgId } : {}),
  ...(scope.teamId ? { teamId: scope.teamId } : {}),
});

type MembershipReader = Pick<
  FastifyInstance['prisma'],
  'organizationMembership' | 'teamMembership'
>;

/**
 * The scopes a person's per-user limits are resolved at: the repository's, then every active team
 * they belong to (by id), then every organization they belong to (by id), without repeats and at
 * most {@link MAX_LIMIT_SCOPES} in all. The order is fixed so the same person always gets the same
 * set; a person in more scopes than the cap is limited by the first ones.
 */
export async function limitScopes(
  prisma: MembershipReader,
  userId: string,
  primary: PlanScope
): Promise<LimitScope[]> {
  const [teams, orgs] = await runUnscoped(
    'a per-user limit is the strictest of the teams and organizations the person belongs to',
    ['TeamMembership', 'OrganizationMembership'],
    () =>
      Promise.all([
        prisma.teamMembership.findMany({
          orderBy: { teamId: 'asc' },
          select: { team: { select: { id: true, orgId: true } } },
          take: MAX_LIMIT_SCOPES,
          where: { team: { isActive: true }, userId },
        }),
        prisma.organizationMembership.findMany({
          orderBy: { orgId: 'asc' },
          select: { orgId: true },
          take: MAX_LIMIT_SCOPES,
          where: { userId },
        }),
      ])
  );
  const out: LimitScope[] = [{ orgId: primary.orgId, teamId: primary.teamId }];
  const seen = new Set([`${primary.teamId}`]);
  for (const m of teams) {
    if (!seen.has(m.team.id)) {
      seen.add(m.team.id);
      out.push({ orgId: m.team.orgId ?? null, teamId: m.team.id });
    }
  }
  const seenOrgs = new Set<string>();
  for (const scope of out) {
    if (scope.orgId) {
      seenOrgs.add(scope.orgId);
    }
  }
  for (const m of orgs) {
    if (!seenOrgs.has(m.orgId)) {
      seenOrgs.add(m.orgId);
      out.push({ orgId: m.orgId, teamId: null });
    }
  }
  return out.slice(0, MAX_LIMIT_SCOPES);
}

type LimitKey =
  | 'runPlans.createPerUserPerHour'
  | 'runPlans.maxPendingPerUser'
  | 'runPlans.routePerUserPerHour';

/** The smallest value a per-user limit has at any of the person's scopes. */
async function strictestLimits<K extends LimitKey>(
  prisma: MembershipReader,
  userId: string,
  primary: PlanScope,
  keys: readonly K[]
): Promise<Record<K, number>> {
  const scopes = await limitScopes(prisma, userId, primary);
  const resolved = await Promise.all(
    scopes.map((scope) => resolveSettings([...keys], limitCtx(scope)))
  );
  const out = {} as Record<K, number>;
  for (const key of keys) {
    out[key] = Math.min(...resolved.map((r) => r[key] as number));
  }
  return out;
}

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

export type GenerationReservation = { ok: true; auditId: string | undefined } | PlanRefusal;

/**
 * Check the kill switch, the hourly generation limit and the pending-plan cap for a person, and
 * (when all pass) record the generation as started, atomically. Returns a refusal to send, or the
 * id of the audit row this call inserted: that row, and only that row, is what {@link
 * releaseGenerationSlot} may later delete. (A retried Idempotency-Key derives one plan id for every
 * request that carries it, so the plan id cannot identify a row: deleting by it would let a losing
 * duplicate delete the winner's row and leave a started job uncounted.)
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
    /** Where the request came from (`slack`); recorded on the audit row. Never intent text. */
    source?: string;
    now?: Date;
  }
): Promise<GenerationReservation> {
  const s = await resolveSettings(['runPlans.enabled'], settingsCtx(args.scope));
  if (!s['runPlans.enabled']) {
    return disabled('Run plans are disabled');
  }
  const limits = await strictestLimits(app.prisma, args.user.sub, args.scope, [
    'runPlans.createPerUserPerHour',
    'runPlans.maxPendingPerUser',
  ]);
  const perHour = limits['runPlans.createPerUserPerHour'];
  if (perHour === 0) {
    return disabled('Plan generation is disabled');
  }
  const now = args.now ?? new Date();
  return app.prisma.$transaction(async (tx): Promise<GenerationReservation> => {
    // CLAUDE.md §7 exception: serialize one person's quota check with its insert across replicas;
    // Prisma cannot express an advisory lock.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`run-plan-quota:${args.user.sub}`}, 0))`;
    if ((await pendingPlans(tx, args.user.sub, now)) >= limits['runPlans.maxPendingPerUser']) {
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
    const auditId = await writeAuditLogRow(app, {
      action: 'CREATE',
      actor: args.user,
      after: {
        connectionId: args.repoId,
        event: GENERATION_STARTED,
        jobId: args.jobId,
        mode: args.mode,
        ...(args.source ? { source: args.source } : {}),
        teamId: args.scope.teamId,
      },
      client: tx,
      entityId: args.planId,
      entityType: 'RunPlan',
    });
    return { auditId, ok: true };
  });
}

/**
 * Take back the one generation row this request inserted, because its job never started. Deletes
 * by the row's own id, never by plan id or event, so another request's row (the winner of a retried
 * Idempotency-Key) is out of reach. A reservation with no row id deletes nothing.
 */
export async function releaseGenerationSlot(
  app: FastifyInstance,
  args: { userId: string; auditId: string | undefined }
): Promise<void> {
  if (!args.auditId) {
    return;
  }
  try {
    await app.prisma.configAuditLog.deleteMany({
      where: {
        action: 'CREATE',
        actorId: args.userId,
        afterJson: { equals: GENERATION_STARTED, path: ['event'] },
        entityType: 'RunPlan',
        id: args.auditId,
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
  const s = await resolveSettings(['runPlans.enabled'], settingsCtx(args.scope));
  if (!s['runPlans.enabled']) {
    return disabled('Run plans are disabled');
  }
  const perHour = (
    await strictestLimits(app.prisma, args.user.sub, args.scope, ['runPlans.routePerUserPerHour'])
  )['runPlans.routePerUserPerHour'];
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
  prisma: Pick<FastifyInstance['prisma'], 'runPlan' | 'team'> & MembershipReader,
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
      const s = await resolveSettings(['runPlans.enabled'], settingsCtx(scope));
      if (!s['runPlans.enabled']) {
        return disabled('Run plans are disabled');
      }
      const { 'runPlans.maxPendingPerUser': maxPending } = await strictestLimits(
        prisma,
        userId,
        scope,
        ['runPlans.maxPendingPerUser']
      );
      if ((await pendingPlans(prisma, userId, nowOf())) >= maxPending) {
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
