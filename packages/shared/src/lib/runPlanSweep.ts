import { resolveSetting } from '../config/resolveSetting.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { runUnscoped } from './tenantGuard.js';

/** How long an expired or rejected plan is kept before the sweeper deletes it. */
export const DEFAULT_PLAN_RETENTION_MS = 7 * 24 * 3_600_000;
/** Plans one sweep expires and records; the next scheduled run continues past it. */
export const EXPIRE_BATCH = 500;

/** Launched plans one sweep scrubs; the next scheduled run continues past it. */
export const SCRUB_BATCH = 200;
/** What a scrubbed plan's hash columns hold: both are NOT NULL text with no format CHECK. */
export const SCRUBBED_HASH = 'scrubbed';
const DAY_MS = 24 * 3_600_000;

/** The team and organization a plan's retention is resolved under. */
export interface PlanRetentionScope {
  teamId: string;
  orgId: string;
}

export interface ExpirePlansResult {
  expired: number;
  /** The plans this sweep moved to EXPIRED, for the audit rows the caller writes. */
  expiredIds: string[];
  deleted: number;
  /** The LAUNCHED plans this sweep scrubbed, for the audit rows the caller writes. */
  scrubbed: Array<{ id: string; teamId: string; mode: string }>;
}

/**
 * What survives a scrub of the cost estimate: the numbers. `perStep` and `unpriced` name nodes of
 * the spec by id, and a node id is model-authored text, so both go; the total stays for the list.
 */
function scrubbedCost(cost: unknown): Record<string, unknown> {
  const c =
    cost && typeof cost === 'object' && !Array.isArray(cost)
      ? (cost as Record<string, unknown>)
      : {};
  return {
    exclusions: '',
    fanOutWidthAssumed: typeof c.fanOutWidthAssumed === 'number' ? c.fanOutWidthAssumed : 0,
    perStep: [],
    totalUsd: typeof c.totalUsd === 'number' ? c.totalUsd : 0,
    unpriced: [],
  };
}

/**
 * The run-plan sweeper: PENDING and APPROVED-but-unlaunched plans past their expiry become
 * EXPIRED, and EXPIRED or REJECTED plans older than the retention window are deleted. Cross-tenant
 * by nature, so every query is marked `runUnscoped`. LAUNCHED plans are never deleted: a run names
 * them (`triggerRefId` is the plan id). After `runPlans.launchedRetentionDays` (resolved at the
 * plan's own team and organization; 0 keeps them forever) a LAUNCHED plan is SCRUBBED instead:
 * its goal and plan body are removed and `scrubbedAt` is set, and the row stays.
 *
 * Launch time is `approvedAt`: the schema records no separate launch timestamp, and a launch
 * follows its approval within the launch window (minutes).
 *
 * What a scrub removes, in ONE `updateMany` per plan that repeats the status and
 * `scrubbedAt IS NULL` predicates (two sweepers racing: exactly one matches):
 * - `intent` (the goal), `spec` (the plan body) and `routerCandidates` (the plan summary, the
 *   injected node ids and the intent hash), and the hashes of the spec and catalog.
 * - `skeletonReport` and `validationReport`: both are made of node ids, regions and warning
 *   messages quoting the spec.
 * - `costEstimate` keeps its numbers only: `perStep` and `unpriced` name nodes by id.
 * Kept because they hold no goal or plan text: `agentPins` (agent keys and versions) and
 * `settingsSnapshot` (registry values), and every metadata column.
 *
 * The ids come from a read, then the write names them with the same predicates again, then a read
 * confirms which are now EXPIRED: an approval that extended a plan's expiry between the two steps
 * keeps its plan out of both the update and the list.
 */
export async function expireRunPlans(
  prisma: Pick<PrismaClient, 'runPlan' | 'team'>,
  now: Date,
  opts: {
    retentionMs?: number;
    /** The launched-plan retention in days at a scope; defaults to the registry setting. */
    launchedRetentionDays?: (scope: PlanRetentionScope) => Promise<number>;
  } = {}
): Promise<ExpirePlansResult> {
  const cutoff = new Date(now.getTime() - (opts.retentionMs ?? DEFAULT_PLAN_RETENTION_MS));
  const due = await runUnscoped(
    'the plan sweeper finds stale plans of every team',
    ['RunPlan'],
    () =>
      prisma.runPlan.findMany({
        orderBy: { expiresAt: 'asc' },
        select: { id: true },
        take: EXPIRE_BATCH,
        where: { expiresAt: { lte: now }, status: { in: ['PENDING', 'APPROVED'] } },
      })
  );
  let expiredIds: string[] = [];
  if (due.length > 0) {
    const ids = due.map((r) => r.id);
    await runUnscoped('the plan sweeper expires stale plans of every team', ['RunPlan'], () =>
      prisma.runPlan.updateMany({
        data: { status: 'EXPIRED' },
        where: {
          expiresAt: { lte: now },
          id: { in: ids },
          status: { in: ['PENDING', 'APPROVED'] },
        },
      })
    );
    const confirmed = await runUnscoped(
      'the plan sweeper confirms which plans it expired',
      ['RunPlan'],
      () =>
        prisma.runPlan.findMany({
          select: { id: true },
          where: { id: { in: ids }, status: 'EXPIRED' },
        })
    );
    expiredIds = confirmed.map((r) => r.id);
  }
  const deleted = await runUnscoped(
    'the plan sweeper deletes old expired and rejected plans of every team',
    ['RunPlan'],
    () =>
      prisma.runPlan.deleteMany({
        where: { createdAt: { lt: cutoff }, status: { in: ['EXPIRED', 'REJECTED'] } },
      })
  );
  const scrubbed = await scrubLaunchedPlans(prisma, now, opts.launchedRetentionDays);
  return { deleted: deleted.count, expired: expiredIds.length, expiredIds, scrubbed };
}

async function scrubLaunchedPlans(
  prisma: Pick<PrismaClient, 'runPlan' | 'team'>,
  now: Date,
  retentionOf: ((scope: PlanRetentionScope) => Promise<number>) | undefined
): Promise<ExpirePlansResult['scrubbed']> {
  const resolveDays =
    retentionOf ??
    (async (scope: PlanRetentionScope) =>
      resolveSetting('runPlans.launchedRetentionDays', {
        orgId: scope.orgId,
        teamId: scope.teamId,
      }));
  // The shortest retention is one day, so only plans approved before then can be due anywhere.
  const earliest = new Date(now.getTime() - DAY_MS);
  // One aggregate row per team, computed in SQL: no plan row is loaded to find the teams.
  const groups = await runUnscoped(
    'the plan sweeper finds the teams that hold launched plans',
    ['RunPlan'],
    () =>
      prisma.runPlan.groupBy({
        by: ['teamId'],
        orderBy: { teamId: 'asc' },
        where: { approvedAt: { lt: earliest }, scrubbedAt: null, status: 'LAUNCHED' },
      })
  );
  // Resolve each team's retention first; a team that resolves to 0 (or cannot be read) is dropped
  // here and its plans are never read.
  const active: Array<{ teamId: string; cutoff: Date; exhausted: boolean }> = [];
  const teamRows =
    groups.length === 0
      ? []
      : await runUnscoped('the plan sweeper reads the organization of each team', ['Team'], () =>
          prisma.team.findMany({
            select: { id: true, orgId: true },
            where: { id: { in: groups.map((g) => g.teamId) } },
          })
        );
  const orgOf = new Map(teamRows.map((t) => [t.id, t.orgId]));
  for (const { teamId } of groups) {
    const orgId = orgOf.get(teamId);
    if (orgId === undefined) {
      continue;
    }
    let days: number;
    try {
      days = await resolveDays({ orgId, teamId });
    } catch {
      // An unreadable setting scrubs nothing: deleting text is never the safe guess.
      continue;
    }
    if (!Number.isFinite(days) || days <= 0) {
      continue;
    }
    active.push({ cutoff: new Date(now.getTime() - days * DAY_MS), exhausted: false, teamId });
  }
  const scrubbed: ExpirePlansResult['scrubbed'] = [];
  // Round-robin passes so one team with a backlog cannot starve the others: each pass gives every
  // team that is not yet drained an equal share of what is left of the batch.
  while (scrubbed.length < SCRUB_BATCH) {
    const live = active.filter((t) => !t.exhausted);
    if (live.length === 0) {
      break;
    }
    const share = Math.max(1, Math.floor((SCRUB_BATCH - scrubbed.length) / live.length));
    for (const team of live) {
      if (scrubbed.length >= SCRUB_BATCH) {
        break;
      }
      const take = Math.min(share, SCRUB_BATCH - scrubbed.length);
      const due = await runUnscoped(
        'the plan sweeper finds launched plans past their retention',
        ['RunPlan'],
        () =>
          prisma.runPlan.findMany({
            orderBy: { approvedAt: 'asc' },
            select: { costEstimate: true, id: true, mode: true },
            take,
            where: {
              approvedAt: { lt: team.cutoff },
              scrubbedAt: null,
              status: 'LAUNCHED',
              teamId: team.teamId,
            },
          })
      );
      // Fewer rows than asked for means the team is drained; a full page may have more behind it.
      if (due.length < take) {
        team.exhausted = true;
      }
      for (const plan of due) {
        const result = await runUnscoped(
          'the plan sweeper scrubs one launched plan past its retention',
          ['RunPlan'],
          () =>
            prisma.runPlan.updateMany({
              data: {
                catalogHash: SCRUBBED_HASH,
                costEstimate: scrubbedCost(plan.costEstimate) as object,
                intent: '',
                routerCandidates: {},
                scrubbedAt: now,
                skeletonReport: {},
                spec: {},
                specHash: SCRUBBED_HASH,
                validationReport: {},
              },
              where: {
                approvedAt: { lt: team.cutoff },
                id: plan.id,
                scrubbedAt: null,
                status: 'LAUNCHED',
                teamId: team.teamId,
              },
            })
        );
        if (result.count === 1) {
          scrubbed.push({ id: plan.id, mode: plan.mode, teamId: team.teamId });
        }
      }
    }
  }
  return scrubbed;
}
