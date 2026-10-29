import { Readable } from 'node:stream';
import type { Prisma } from '@auto-swe/shared';
import {
  attributeLauncher,
  chunked,
  DAY_MS,
  loadRunLaunchers,
  rollupHorizonMs,
} from '@auto-swe/shared/lib/agentTraceRollup';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { csvRow } from '../lib/csv.js';
import {
  customRangeFields,
  refineCustomRange,
  resolveCustomRange,
  seriesBuckets,
  utcDayStart,
} from '../lib/dateWindow.js';
import { sendError } from '../lib/httpErrors.js';
import { mapLimited } from '../lib/mapLimited.js';
import { asPlatformAdmin } from '../lib/platformAdminScope.js';
import {
  clipRanges,
  coveredRollupDays,
  planWindow,
  timeWhere,
  type WindowPlan,
} from '../lib/usageWindows.js';
import { hasRole, type JwtPayload, requireAuth, requireUser } from '../plugins/auth.js';

/**
 * LLM usage, aggregated from `agent_traces`.
 *
 * Every LLM call and every successful embedding call — run or no run — writes
 * one `llm_response` row carrying its model, tokens, cost, and the team and
 * organization whose spend it is, so those rows are the one place spend is
 * recorded for every workflow. Run-level totals (`WorkflowRun.costUsdAccrued`)
 * miss workflows that keep no run.
 *
 * Scoped by `teamId` or `orgId`, or platform-wide. An ADMIN may read any of
 * them; a team LEAD (by team membership) their team; an ORG_ADMIN their
 * organization. The platform-wide report is ADMIN-only, because it includes
 * spend no team owns.
 */

const WINDOWS = [7, 30, 90] as const;
/**
 * The gateway's pg pool holds 10 connections. At most four window-wide queries
 * run together, then the per-day aggregates this many at a time, so one report
 * never holds the whole pool against auth and webhook traffic.
 */
const DAILY_CONCURRENCY = 3;
const TOP_RUNS = 10;
/**
 * When the live traces and the rollup both contribute, each source first keeps this many leading
 * runs. The merged ranking is checked against a threshold bound (see the top-runs block); if the
 * bound is not met the lists are widened once to `TOP_RUN_WIDE`. Past that the ranking is not
 * guaranteed exact: a run would have to rank below `TOP_RUN_WIDE` in both sources.
 */
const TOP_RUN_CANDIDATES = 100;
const TOP_RUN_WIDE = 5000;
/** How many ranked runs are looked up, so ones deleted since are skipped without a short list. */
const TOP_RUN_LOOKUP = 200;
const TOP_USERS = 10;

const UsageQueryBase = z
  .object({
    ...customRangeFields,
    orgId: z.string().uuid().optional(),
    teamId: z.string().uuid().optional(),
    window: z.coerce
      .number()
      .int()
      .refine((n) => (WINDOWS as readonly number[]).includes(n), {
        message: `window must be one of ${WINDOWS.join(', ')}`,
      })
      .default(30),
  })
  .refine((q) => !(q.teamId && q.orgId), { message: 'pass teamId or orgId, not both' });
const UsageQuery = refineCustomRange(UsageQueryBase);
const UsageExportQuery = refineCustomRange(
  UsageQueryBase.extend({ format: z.enum(['csv', 'ndjson']).default('csv') })
);

type UsageScope = { teamId?: string; orgId?: string };

interface UsageBucket {
  calls: number;
  costUsd: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  /** Mean duration of the calls that succeeded — a timeout is not a latency. */
  avgDurationMs: number | null;
}

/** Running sums a bucket is computed from. */
interface Acc {
  calls: number;
  costUsd: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  okDurationMs: number;
  okDurationCount: number;
}

const emptyAcc = (): Acc => ({
  calls: 0,
  costUsd: 0,
  errors: 0,
  inputTokens: 0,
  okDurationCount: 0,
  okDurationMs: 0,
  outputTokens: 0,
});

function toBucket(a: Acc): UsageBucket {
  return {
    avgDurationMs: a.okDurationCount > 0 ? a.okDurationMs / a.okDurationCount : null,
    calls: a.calls,
    costUsd: a.costUsd,
    errors: a.errors,
    inputTokens: a.inputTokens,
    outputTokens: a.outputTokens,
  };
}

/** A grouped row of `llm_response` traces, and the same group's failed calls. */
interface Group {
  _count: { _all: number; durationMs: number };
  _sum: {
    costUsd?: number | null;
    durationMs: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
  };
}

/** A live group as running sums, leaving its failed calls out of latency. */
function liveAcc(g: Group, failed: Group | undefined): Acc {
  return {
    calls: g._count._all,
    costUsd: g._sum.costUsd ?? 0,
    errors: failed?._count._all ?? 0,
    inputTokens: g._sum.inputTokens ?? 0,
    okDurationCount: g._count.durationMs - (failed?._count.durationMs ?? 0),
    okDurationMs: (g._sum.durationMs ?? 0) - (failed?._sum.durationMs ?? 0),
    outputTokens: g._sum.outputTokens ?? 0,
  };
}

/** The sums of a `groupBy`/`aggregate` over `agent_trace_daily_usage`. */
const ROLLUP_SUM = {
  calls: true,
  costUsd: true,
  errors: true,
  inputTokens: true,
  okDurationCount: true,
  okDurationMs: true,
  outputTokens: true,
} as const;

interface RollupSum {
  calls: number | null;
  costUsd: { toNumber(): number } | number | null;
  errors: number | null;
  inputTokens: bigint | number | null;
  okDurationCount: number | null;
  okDurationMs: bigint | number | null;
  outputTokens: bigint | number | null;
}

/** A rollup group as running sums; same quantities, stored instead of derived. */
function rollupAcc(s: RollupSum): Acc {
  const n = (v: bigint | number | null) => (v === null ? 0 : Number(v));
  return {
    calls: s.calls ?? 0,
    costUsd: s.costUsd === null ? 0 : Number(s.costUsd),
    errors: s.errors ?? 0,
    inputTokens: n(s.inputTokens),
    okDurationCount: s.okDurationCount ?? 0,
    okDurationMs: n(s.okDurationMs),
    outputTokens: n(s.outputTokens),
  };
}

function addAcc(accs: Acc[], x: Acc): void {
  for (const a of accs) {
    a.calls += x.calls;
    a.costUsd += x.costUsd;
    a.errors += x.errors;
    a.inputTokens += x.inputTokens;
    a.outputTokens += x.outputTokens;
    a.okDurationMs += x.okDurationMs;
    a.okDurationCount += x.okDurationCount;
  }
}

/** May `user` read the report for `scope`? See the module comment. */
async function mayReadUsage(
  prisma: FastifyInstance['prisma'],
  user: JwtPayload,
  scope: UsageScope
): Promise<boolean> {
  if (user.role === 'ADMIN') {
    return true;
  }
  if (scope.teamId) {
    const membership = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { teamId: scope.teamId, userId: user.sub } },
    });
    return membership !== null && hasRole(membership.role, 'LEAD');
  }
  if (scope.orgId) {
    const membership = await prisma.organizationMembership.findUnique({
      where: { userId_orgId: { orgId: scope.orgId, userId: user.sub } },
    });
    return membership?.role === 'ORG_ADMIN';
  }
  return false;
}

/**
 * Why an ADMIN's trace queries may span every tenant. Everyone else reaches
 * them only with a team or org predicate, which the tenant guard checks.
 */
const PLATFORM_WIDE = 'ADMIN usage report spans every tenant';

interface UserRow {
  userId: string | null;
  /** Null for the aggregated row of launchers outside the report's team or organization. */
  name: string | null;
  /** Only an ADMIN sees an email. */
  email: string | null;
  outsideScope: boolean;
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Spend by the user who launched the run, ranked by cost.
 *
 * A trace is attributed to `WorkflowRun.launchedById` only when its Temporal run id is the one the
 * run row was written by (`attributeLauncher`); rollup days carry that answer already, live days
 * resolve it here. What the caller may learn about a launcher depends on their role: an ADMIN sees
 * everyone, with email; a team LEAD or ORG_ADMIN sees the names of launchers who belong to the
 * team or organization the report is scoped to, and every other launcher is folded into one
 * unnamed "outside" row so a report for one team does not reveal who else spends elsewhere.
 */
async function usageByUser(args: {
  current: WindowPlan;
  llm: Prisma.AgentTraceWhereInput;
  rolled: Prisma.AgentTraceDailyUsageWhereInput;
  prisma: FastifyInstance['prisma'];
  scope: UsageScope;
  user: JwtPayload;
}): Promise<{
  byUser: UserRow[];
  unattributed: (totals: Acc) => { calls: number; costUsd: number };
}> {
  const { current, llm, rolled, prisma, scope, user } = args;
  const sums = new Map<string, Omit<UserRow, 'userId' | 'name' | 'email' | 'outsideScope'>>();
  const add = (
    id: string,
    x: { calls: number; costUsd: number; inputTokens: number; outputTokens: number }
  ) => {
    const t = sums.get(id) ?? { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    t.calls += x.calls;
    t.costUsd += x.costUsd;
    t.inputTokens += x.inputTokens;
    t.outputTokens += x.outputTokens;
    sums.set(id, t);
  };
  if (current.live.length > 0) {
    const liveRuns = await asPlatformAdmin(
      user,
      PLATFORM_WIDE,
      ['AgentTrace', 'AgentTraceDailyUsage'],
      () =>
        prisma.agentTrace.groupBy({
          _count: { _all: true },
          _sum: { costUsd: true, inputTokens: true, outputTokens: true },
          by: ['runId', 'temporalRunId'],
          where: { ...llm, runId: { not: null } },
        })
    );
    const launchers = await loadRunLaunchers(
      prisma,
      liveRuns.flatMap((g) => (g.runId ? [g.runId] : [])),
      DAILY_CONCURRENCY
    );
    for (const g of liveRuns) {
      const id = attributeLauncher(g.runId ? launchers.get(g.runId) : undefined, g.temporalRunId);
      if (id) {
        add(id, {
          calls: g._count._all,
          costUsd: g._sum.costUsd ?? 0,
          inputTokens: g._sum.inputTokens ?? 0,
          outputTokens: g._sum.outputTokens ?? 0,
        });
      }
    }
  }
  if (current.rollupDays.length > 0) {
    const rows = await asPlatformAdmin(
      user,
      PLATFORM_WIDE,
      ['AgentTrace', 'AgentTraceDailyUsage'],
      () =>
        prisma.agentTraceDailyUsage.groupBy({
          _sum: { calls: true, costUsd: true, inputTokens: true, outputTokens: true },
          by: ['launcherId'],
          where: { ...rolled, launcherId: { not: null } },
        })
    );
    for (const r of rows) {
      if (r.launcherId) {
        add(r.launcherId, {
          calls: r._sum.calls ?? 0,
          costUsd: Number(r._sum.costUsd ?? 0),
          inputTokens: Number(r._sum.inputTokens ?? 0),
          outputTokens: Number(r._sum.outputTokens ?? 0),
        });
      }
    }
  }

  const launcherIds = [...sums.keys()];
  // Who belongs to the report's team or organization. An ADMIN needs no such limit.
  let inScope: Set<string>;
  if (user.role === 'ADMIN' || launcherIds.length === 0) {
    inScope = new Set(launcherIds);
  } else if (scope.teamId) {
    const members = await prisma.teamMembership.findMany({
      select: { userId: true },
      where: { teamId: scope.teamId, userId: { in: launcherIds } },
    });
    inScope = new Set(members.map((m) => m.userId));
  } else if (scope.orgId) {
    const orgId = scope.orgId;
    const [orgMembers, teamMembers] = await Promise.all([
      prisma.organizationMembership.findMany({
        select: { userId: true },
        where: { orgId, userId: { in: launcherIds } },
      }),
      runUnscoped(
        "launchers' teams inside the organization the caller administers",
        ['TeamMembership'],
        () =>
          prisma.teamMembership.findMany({
            select: { userId: true },
            where: { team: { orgId }, userId: { in: launcherIds } },
          })
      ),
    ]);
    inScope = new Set([...orgMembers, ...teamMembers].map((m) => m.userId));
  } else {
    inScope = new Set();
  }

  const outside = { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
  let outsideAny = false;
  const named: Array<[string, typeof outside]> = [];
  for (const [id, x] of sums) {
    if (inScope.has(id)) {
      named.push([id, x]);
    } else {
      outsideAny = true;
      outside.calls += x.calls;
      outside.costUsd += x.costUsd;
      outside.inputTokens += x.inputTokens;
      outside.outputTokens += x.outputTokens;
    }
  }
  named.sort((a, b) => b[1].costUsd - a[1].costUsd);
  const top = named.slice(0, TOP_USERS);
  const users = top.length
    ? await prisma.user.findMany({
        select: { email: true, id: true, name: true },
        where: { id: { in: top.map(([id]) => id) } },
      })
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));
  const byUser: UserRow[] = top.map(([id, x]) => ({
    ...x,
    email: user.role === 'ADMIN' ? (userById.get(id)?.email ?? null) : null,
    name: userById.get(id)?.name ?? null,
    outsideScope: false,
    userId: id,
  }));
  if (outsideAny) {
    byUser.push({
      ...outside,
      email: null,
      name: null,
      outsideScope: true,
      userId: null,
    });
  }
  let attributedCalls = 0;
  let attributedCost = 0;
  for (const x of sums.values()) {
    attributedCalls += x.calls;
    attributedCost += x.costUsd;
  }
  return {
    byUser,
    unattributed: (totals) => ({
      calls: Math.max(0, totals.calls - attributedCalls),
      costUsd: Math.max(0, Math.round((totals.costUsd - attributedCost) * 1e10) / 1e10),
    }),
  };
}

export const usageRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const prisma = fastify.prisma;
  type UsageReportRequest = FastifyRequest<{ Querystring: z.infer<typeof UsageQuery> }>;

  app.get(
    '/usage/export',
    {
      onRequest: requireAuth(),
      schema: { querystring: UsageExportQuery },
    },
    async (request, reply) => {
      const { format } = request.query;
      const report = await buildUsageReport(request as unknown as UsageReportRequest, reply);
      if (reply.sent) {
        return reply;
      }
      const { data } = report as unknown as {
        data: Record<string, Array<Record<string, unknown>>>;
      };
      const dimensions = [
        { key: 'byModel', name: 'model', value: (row: Record<string, unknown>) => row.model },
        { key: 'byAgent', name: 'agent', value: (row: Record<string, unknown>) => row.agentKey },
        { key: 'byActivity', name: 'node', value: (row: Record<string, unknown>) => row.nodeId },
      ] as const;
      const columns = [
        'dimension',
        'value',
        'calls',
        'cost_usd',
        'errors',
        'input_tokens',
        'output_tokens',
        'avg_duration_ms',
      ];
      const rows = dimensions.flatMap(({ key, name, value }) =>
        (data[key] ?? []).map((row) => [
          name,
          value(row) ?? '(unattributed)',
          row.calls,
          row.costUsd,
          row.errors,
          row.inputTokens,
          row.outputTokens,
          row.avgDurationMs,
        ])
      );
      async function* lines() {
        if (format === 'csv') {
          yield csvRow(columns);
        }
        for (const row of rows) {
          yield format === 'csv'
            ? csvRow(row)
            : `${JSON.stringify(Object.fromEntries(columns.map((key, index) => [key, row[index]])))}\n`;
        }
      }
      return reply
        .header('Content-Disposition', `attachment; filename="platform-usage.${format}"`)
        .header(
          'Content-Type',
          format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson'
        )
        .send(Readable.from(lines()));
    }
  );

  // Which reports the caller may read, by the same rules as `mayReadUsage`.
  // The page gates on this being non-empty, so the two cannot disagree; the
  // report route still checks every request itself.
  app.get('/usage/scopes', { onRequest: requireAuth() }, async (request) => {
    const user = requireUser(request);
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    if (user.role === 'ADMIN') {
      const [teams, orgs] = await Promise.all([
        runUnscoped('an ADMIN lists every team they may report on', ['Team'], () =>
          prisma.team.findMany({ select: { id: true, name: true } })
        ),
        prisma.organization.findMany({ select: { id: true, name: true } }),
      ]);
      return {
        data: { orgs: orgs.sort(byName), platform: true, teams: teams.sort(byName) },
      };
    }
    const [teamMemberships, orgMemberships] = await runUnscoped(
      "the caller's own memberships",
      ['TeamMembership', 'OrganizationMembership'],
      () =>
        Promise.all([
          prisma.teamMembership.findMany({
            select: { role: true, team: { select: { id: true, name: true } } },
            where: { userId: user.sub },
          }),
          prisma.organizationMembership.findMany({
            select: { organization: { select: { id: true, name: true } }, role: true },
            where: { role: 'ORG_ADMIN', userId: user.sub },
          }),
        ])
    );
    return {
      data: {
        orgs: orgMemberships.map((m) => m.organization).sort(byName),
        platform: false,
        teams: teamMemberships
          .filter((m) => hasRole(m.role, 'LEAD'))
          .map((m) => m.team)
          .sort(byName),
      },
    };
  });

  app.get(
    '/usage',
    {
      onRequest: requireAuth(),
      schema: { querystring: UsageQuery },
    },
    async (request, reply) => buildUsageReport(request, reply)
  );

  async function buildUsageReport(request: UsageReportRequest, reply: FastifyReply) {
    const user = requireUser(request);
    const { orgId, teamId } = request.query;
    const custom = resolveCustomRange(request.query);
    const windowDays = custom?.days ?? request.query.window;
    const scope: UsageScope = teamId ? { teamId } : orgId ? { orgId } : {};
    if (!(await mayReadUsage(prisma, user, scope))) {
      return sendError(
        reply,
        403,
        'FORBIDDEN',
        'The platform-wide report is ADMIN-only; a team LEAD may read their team, an ORG_ADMIN their organization'
      );
    }
    // Whole UTC days, closed at the end of today, so every query covers
    // exactly the rows the daily bars do — including a request that runs
    // across midnight.
    const now = Date.now();
    const until = custom?.end ?? new Date(utcDayStart(now) + DAY_MS);
    const since = custom?.start ?? new Date(until.getTime() - windowDays * DAY_MS);
    const previousSince = new Date(since.getTime() - windowDays * DAY_MS);

    // Completed days come from the daily rollup when the sweep has built it; every other day —
    // the trailing days the sweep still rewrites, and any day it has not reached — is read from
    // the traces, so the rollup is an optimization and never changes a number.
    const covered = await coveredRollupDays(prisma, previousSince.getTime(), until.getTime(), now);
    const horizon = rollupHorizonMs(now);
    const current = planWindow(since.getTime(), until.getTime(), covered, horizon);
    const previousPlan = planWindow(previousSince.getTime(), since.getTime(), covered, horizon);
    const hasLive = current.live.length > 0;
    const hasRollup = current.rollupDays.length > 0;
    const llm = { ...scope, ...timeWhere(current.live), type: 'llm_response' };
    const rolled = { ...scope, day: { in: current.rollupDays } };

    // One grouping by (model, agent, activity) serves the totals and all
    // three breakdowns: the key space is small, and it saves a full-window
    // scan per breakdown. With a rollup in play a run can rank in either
    // source, so each keeps a candidate list wide enough to merge.
    const topRunsTake = hasRollup ? TOP_RUN_CANDIDATES : TOP_RUNS;
    const [groups, failedGroups, unattributed, topRunGroups] = hasLive
      ? await asPlatformAdmin(user, PLATFORM_WIDE, ['AgentTrace', 'AgentTraceDailyUsage'], () =>
          Promise.all([
            prisma.agentTrace.groupBy({
              _count: { _all: true, durationMs: true },
              _sum: { costUsd: true, durationMs: true, inputTokens: true, outputTokens: true },
              by: ['model', 'agentKey', 'nodeId'],
              where: llm,
            }),
            prisma.agentTrace.groupBy({
              _count: { _all: true, durationMs: true },
              _sum: { durationMs: true },
              by: ['model', 'agentKey', 'nodeId'],
              where: { ...llm, error: { not: null } },
            }),
            prisma.agentTrace.aggregate({
              _count: { _all: true },
              _sum: { costUsd: true },
              where: { ...llm, runId: null },
            }),
            prisma.agentTrace.groupBy({
              _sum: { costUsd: true, inputTokens: true, outputTokens: true },
              by: ['runId'],
              having: { costUsd: { _sum: { gt: 0 } } },
              orderBy: { _sum: { costUsd: 'desc' } },
              take: topRunsTake,
              where: { ...llm, runId: { not: null } },
            }),
          ])
        )
      : [[], [], { _count: { _all: 0 }, _sum: { costUsd: null } }, []];
    const [rolledGroups, rolledUnattributed, rolledTopRuns] = hasRollup
      ? await asPlatformAdmin(user, PLATFORM_WIDE, ['AgentTrace', 'AgentTraceDailyUsage'], () =>
          Promise.all([
            prisma.agentTraceDailyUsage.groupBy({
              _sum: ROLLUP_SUM,
              by: ['model', 'agentKey', 'nodeId'],
              where: rolled,
            }),
            prisma.agentTraceDailyUsage.aggregate({
              _sum: { calls: true, costUsd: true },
              where: { ...rolled, runId: null },
            }),
            prisma.agentTraceDailyUsage.groupBy({
              _sum: { costUsd: true, inputTokens: true, outputTokens: true },
              by: ['runId'],
              having: { costUsd: { _sum: { gt: 0 } } },
              orderBy: { _sum: { costUsd: 'desc' } },
              take: topRunsTake,
              where: { ...rolled, runId: { not: null } },
            }),
          ])
        )
      : [[], { _sum: { calls: null, costUsd: null } }, []];

    // The window of the same length just before this one, so the page can say whether spend
    // is moving, not only how big it is. Run after the batches above, not inside them, so no more
    // than four queries ever hold pool connections together.
    const previousLive = previousPlan.live.length
      ? await asPlatformAdmin(user, PLATFORM_WIDE, ['AgentTrace', 'AgentTraceDailyUsage'], () =>
          prisma.agentTrace.aggregate({
            _count: { _all: true },
            _sum: { costUsd: true },
            where: { ...scope, ...timeWhere(previousPlan.live), type: 'llm_response' },
          })
        )
      : { _count: { _all: 0 }, _sum: { costUsd: null } };
    const previousRolled = previousPlan.rollupDays.length
      ? await asPlatformAdmin(user, PLATFORM_WIDE, ['AgentTrace', 'AgentTraceDailyUsage'], () =>
          prisma.agentTraceDailyUsage.aggregate({
            _sum: { calls: true, costUsd: true },
            where: { ...scope, day: { in: previousPlan.rollupDays } },
          })
        )
      : { _sum: { calls: null, costUsd: null } };
    const previousPeriod = {
      calls: previousLive._count._all + (previousRolled._sum.calls ?? 0),
      costUsd: (previousLive._sum.costUsd ?? 0) + Number(previousRolled._sum.costUsd ?? 0),
    };

    // JSON keys keep a null model distinct from any real string.
    const keyOf = (g: { model: string | null; agentKey: string; nodeId: string }) =>
      JSON.stringify([g.model, g.agentKey, g.nodeId]);
    const failedByKey = new Map(failedGroups.map((g) => [keyOf(g), g]));

    const totals = emptyAcc();
    const byModel = new Map<string | null, Acc>();
    const byAgent = new Map<string, Acc>();
    const byActivity = new Map<string, Acc>();
    const into = <K>(m: Map<K, Acc>, k: K): Acc => {
      const existing = m.get(k);
      if (existing) {
        return existing;
      }
      const fresh = emptyAcc();
      m.set(k, fresh);
      return fresh;
    };
    const addKeyed = (g: { model: string | null; agentKey: string; nodeId: string }, a: Acc) =>
      addAcc(
        [totals, into(byModel, g.model), into(byAgent, g.agentKey), into(byActivity, g.nodeId)],
        a
      );
    for (const g of groups) {
      addKeyed(g, liveAcc(g, failedByKey.get(keyOf(g))));
    }
    for (const g of rolledGroups) {
      addKeyed(g, rollupAcc(g._sum));
    }

    // Per tenant, in a second batch so the report never holds more than four
    // pool connections at once.
    const [tenantGroups, failedTenantGroups] = hasLive
      ? await asPlatformAdmin(user, PLATFORM_WIDE, ['AgentTrace', 'AgentTraceDailyUsage'], () =>
          Promise.all([
            prisma.agentTrace.groupBy({
              _count: { _all: true, durationMs: true },
              _sum: { costUsd: true, durationMs: true, inputTokens: true, outputTokens: true },
              by: ['teamId', 'orgId'],
              where: llm,
            }),
            prisma.agentTrace.groupBy({
              _count: { _all: true, durationMs: true },
              _sum: { durationMs: true },
              by: ['teamId', 'orgId'],
              where: { ...llm, error: { not: null } },
            }),
          ])
        )
      : [[], []];
    const rolledTenantGroups = hasRollup
      ? await asPlatformAdmin(user, PLATFORM_WIDE, ['AgentTrace', 'AgentTraceDailyUsage'], () =>
          prisma.agentTraceDailyUsage.groupBy({
            _sum: ROLLUP_SUM,
            by: ['teamId', 'orgId'],
            where: rolled,
          })
        )
      : [];
    const tenantKey = (g: { teamId: string | null; orgId: string | null }) =>
      JSON.stringify([g.teamId, g.orgId]);
    const failedByTenant = new Map(failedTenantGroups.map((g) => [tenantKey(g), g]));
    const byTeam = new Map<string | null, Acc>();
    const teamOrg = new Map<string | null, string | null>();
    const byOrg = new Map<string | null, Acc>();
    const addTenant = (g: { teamId: string | null; orgId: string | null }, a: Acc) => {
      // A team's org, or null when there is no single one: always for the
      // no-team row, which pools ownerless spend from every org, and for a
      // team whose rows were written under different orgs.
      const prev = teamOrg.get(g.teamId);
      teamOrg.set(
        g.teamId,
        g.teamId !== null && (prev === undefined || prev === g.orgId) ? g.orgId : null
      );
      addAcc([into(byTeam, g.teamId), into(byOrg, g.orgId)], a);
    };
    for (const g of tenantGroups) {
      addTenant(g, liveAcc(g, failedByTenant.get(tenantKey(g))));
    }
    for (const g of rolledTenantGroups) {
      addTenant(g, rollupAcc(g._sum));
    }
    const teamIds = [...byTeam.keys()].filter((id): id is string => id !== null);
    const orgIds = [...byOrg.keys()].filter((id): id is string => id !== null);
    const [teams, orgs] = await Promise.all([
      teamIds.length
        ? runUnscoped('names of the teams in a report the caller may read', ['Team'], () =>
            prisma.team.findMany({
              select: { id: true, name: true },
              where: { id: { in: teamIds } },
            })
          )
        : [],
      orgIds.length
        ? prisma.organization.findMany({
            select: { id: true, name: true },
            where: { id: { in: orgIds } },
          })
        : [],
    ]);
    const teamName = new Map(teams.map((t) => [t.id, t.name]));
    const orgName = new Map(orgs.map((o) => [o.id, o.name]));

    const { bucketDays, buckets } = seriesBuckets(since.getTime(), windowDays);
    const rolledDaily = hasRollup
      ? await asPlatformAdmin(user, PLATFORM_WIDE, ['AgentTrace', 'AgentTraceDailyUsage'], () =>
          prisma.agentTraceDailyUsage.groupBy({
            _sum: { calls: true, costUsd: true, inputTokens: true, outputTokens: true },
            by: ['day'],
            where: rolled,
          })
        )
      : [];
    const rolledByDay = new Map(rolledDaily.map((r) => [r.day.getTime(), r._sum]));
    const daily = await mapLimited(buckets, DAILY_CONCURRENCY, async ({ end, start }) => {
      const liveRanges = clipRanges(current.live, start, end);
      const row = liveRanges.length
        ? await asPlatformAdmin(user, PLATFORM_WIDE, ['AgentTrace', 'AgentTraceDailyUsage'], () =>
            prisma.agentTrace.aggregate({
              _count: { _all: true },
              _sum: { costUsd: true, inputTokens: true, outputTokens: true },
              where: { ...scope, ...timeWhere(liveRanges), type: 'llm_response' },
            })
          )
        : { _count: { _all: 0 }, _sum: { costUsd: null, inputTokens: null, outputTokens: null } };
      const sum = {
        calls: row._count._all,
        costUsd: row._sum.costUsd ?? 0,
        inputTokens: row._sum.inputTokens ?? 0,
        outputTokens: row._sum.outputTokens ?? 0,
      };
      for (const day of current.rollupDays) {
        const t = day.getTime();
        const r = t >= start && t < end ? rolledByDay.get(t) : undefined;
        if (r) {
          sum.calls += r.calls ?? 0;
          sum.costUsd += Number(r.costUsd ?? 0);
          sum.inputTokens += Number(r.inputTokens ?? 0);
          sum.outputTokens += Number(r.outputTokens ?? 0);
        }
      }
      return { ...sum, date: new Date(start).toISOString().slice(0, 10) };
    });

    // Top runs. A run can rank in the live traces, in the rollup, or only by the two added, so
    // each source's leaders are completed with the other source's sums before ranking.
    type RunSum = { costUsd: number; inputTokens: number; outputTokens: number };
    const toRunSums = (
      rows: Array<{
        runId: string | null;
        _sum: {
          costUsd: unknown;
          inputTokens: unknown;
          outputTokens: unknown;
        };
      }>
    ) => {
      const m = new Map<string, RunSum>();
      for (const g of rows) {
        if (g.runId) {
          m.set(g.runId, {
            costUsd: Number(g._sum.costUsd ?? 0),
            inputTokens: Number(g._sum.inputTokens ?? 0),
            outputTokens: Number(g._sum.outputTokens ?? 0),
          });
        }
      }
      return m;
    };
    const runSumFields = { costUsd: true, inputTokens: true, outputTokens: true } as const;
    let liveRunSums = toRunSums(topRunGroups);
    let rolledRunSums = toRunSums(rolledTopRuns);
    // Adds each source's sum for the runs only the other source listed.
    const completeRunSums = async () => {
      const candidates = [...new Set([...liveRunSums.keys(), ...rolledRunSums.keys()])];
      const missingLive = candidates.filter((id) => !liveRunSums.has(id));
      const missingRolled = candidates.filter((id) => !rolledRunSums.has(id));
      const [liveFill, rolledFill] = await asPlatformAdmin(
        user,
        PLATFORM_WIDE,
        ['AgentTrace', 'AgentTraceDailyUsage'],
        () =>
          Promise.all([
            missingLive.length
              ? prisma.agentTrace.groupBy({
                  _sum: runSumFields,
                  by: ['runId'],
                  where: { ...llm, runId: { in: missingLive } },
                })
              : [],
            missingRolled.length
              ? prisma.agentTraceDailyUsage.groupBy({
                  _sum: runSumFields,
                  by: ['runId'],
                  where: { ...rolled, runId: { in: missingRolled } },
                })
              : [],
          ])
      );
      for (const [id, r] of toRunSums(liveFill)) {
        liveRunSums.set(id, r);
      }
      for (const [id, r] of toRunSums(rolledFill)) {
        rolledRunSums.set(id, r);
      }
    };
    // Which of the known runs still exist. A rollup row has no foreign key to its run and so
    // outlives it; the threshold test must rank only runs that can be listed.
    const existingRunIds = async (): Promise<Set<string>> => {
      const ids = [...new Set([...liveRunSums.keys(), ...rolledRunSums.keys()])];
      const found = new Set<string>();
      const chunks = chunked(ids);
      for (let i = 0; i < chunks.length; i += DAILY_CONCURRENCY) {
        const rows = await Promise.all(
          chunks
            .slice(i, i + DAILY_CONCURRENCY)
            .map((part) =>
              prisma.workflowRun.findMany({ select: { id: true }, where: { id: { in: part } } })
            )
        );
        for (const r of rows.flat()) {
          found.add(r.id);
        }
      }
      return found;
    };
    // The tenth-best total among existing runs, 0 when fewer than ten.
    const tenthBest = async (): Promise<number> => {
      const exist = await existingRunIds();
      const totals = new Map<string, number>();
      for (const m of [liveRunSums, rolledRunSums]) {
        for (const [id, r] of m) {
          if (exist.has(id)) {
            totals.set(id, (totals.get(id) ?? 0) + r.costUsd);
          }
        }
      }
      return [...totals.values()].sort((x, y) => y - x)[TOP_RUNS - 1] ?? 0;
    };
    if (hasLive && hasRollup) {
      await completeRunSums();
      // Threshold test (as in Fagin's algorithm): a run on neither list has at most the smallest
      // cost of a full list in each source, so if the tenth-best existing total is at least the
      // sum of the two list minimums, the ranking is exact. If not, widen both lists once.
      const floor = (rows: Array<{ _sum: { costUsd: unknown } }>, take: number) =>
        rows.length >= take ? Number(rows.at(-1)?._sum.costUsd ?? 0) : 0;
      if (
        (await tenthBest()) <
        floor(topRunGroups, topRunsTake) + floor(rolledTopRuns, topRunsTake)
      ) {
        const [wideLive, wideRolled] = await asPlatformAdmin(
          user,
          PLATFORM_WIDE,
          ['AgentTrace', 'AgentTraceDailyUsage'],
          () =>
            Promise.all([
              prisma.agentTrace.groupBy({
                _sum: runSumFields,
                by: ['runId'],
                having: { costUsd: { _sum: { gt: 0 } } },
                orderBy: { _sum: { costUsd: 'desc' } },
                take: TOP_RUN_WIDE,
                where: { ...llm, runId: { not: null } },
              }),
              prisma.agentTraceDailyUsage.groupBy({
                _sum: runSumFields,
                by: ['runId'],
                having: { costUsd: { _sum: { gt: 0 } } },
                orderBy: { _sum: { costUsd: 'desc' } },
                take: TOP_RUN_WIDE,
                where: { ...rolled, runId: { not: null } },
              }),
            ])
        );
        liveRunSums = toRunSums(wideLive);
        rolledRunSums = toRunSums(wideRolled);
        await completeRunSums();
        if ((await tenthBest()) < floor(wideLive, TOP_RUN_WIDE) + floor(wideRolled, TOP_RUN_WIDE)) {
          request.log.warn(
            { windowDays },
            'usage top runs: the ranking bound still fails after widening; the list may omit a run'
          );
        }
      }
    }
    const runTotals = new Map<string, RunSum>();
    for (const m of [liveRunSums, rolledRunSums]) {
      for (const [id, r] of m) {
        const t = runTotals.get(id) ?? { costUsd: 0, inputTokens: 0, outputTokens: 0 };
        t.costUsd += r.costUsd;
        t.inputTokens += r.inputTokens;
        t.outputTokens += r.outputTokens;
        runTotals.set(id, t);
      }
    }
    // A rollup row outlives its run (no foreign key), so the ranking is cut to ten only after
    // runs that no longer exist have been dropped.
    const rankedRuns = [...runTotals.entries()]
      .filter(([, r]) => r.costUsd > 0)
      .sort((x, y) => y[1].costUsd - x[1].costUsd)
      .slice(0, TOP_RUN_LOOKUP);

    const runs = rankedRuns.length
      ? await prisma.workflowRun.findMany({
          select: {
            id: true,
            startedAt: true,
            status: true,
            template: { select: { name: true } },
            workRequest: { select: { externalTicketId: true } },
          },
          where: { id: { in: rankedRuns.map(([id]) => id) } },
        })
      : [];
    const runById = new Map(runs.map((r) => [r.id, r]));
    const topRunGroupsMerged = rankedRuns.filter(([id]) => runById.has(id)).slice(0, TOP_RUNS);

    const attributed = await usageByUser({
      current,
      llm,
      prisma,
      rolled,
      scope,
      user,
    });

    const ranked = <K, L extends object>(m: Map<K, Acc>, label: (k: K) => L) =>
      [...m.entries()]
        .map(([k, a]) => ({ ...label(k), ...toBucket(a) }))
        .sort((a, b) => b.costUsd - a.costUsd);

    return {
      data: {
        bucketDays,
        byActivity: ranked(byActivity, (nodeId) => ({ nodeId })),
        byAgent: ranked(byAgent, (agentKey) => ({ agentKey })),
        // A null model is an LLM call whose spec could not be resolved.
        byModel: ranked(byModel, (model) => ({ model })),
        // A null team or org is spend no tenant is derivable for.
        byOrg: ranked(byOrg, (id) => ({
          orgId: id,
          orgName: id ? (orgName.get(id) ?? null) : null,
        })),
        byTeam: ranked(byTeam, (id) => ({
          orgId: teamOrg.get(id) ?? null,
          teamId: id,
          teamName: id ? (teamName.get(id) ?? null) : null,
        })),
        // The launchers who spent most, as far as the caller may see them; see `usageByUser`.
        byUser: attributed.byUser,
        byUserUnattributed: attributed.unattributed(totals),
        daily,
        previous: previousPeriod,
        scope,
        since: since.toISOString(),
        // Ranked by spend inside the window, which for a run that started
        // before it is only part of its cost.
        topRuns: topRunGroupsMerged.flatMap(([id, sums]) => {
          const run = runById.get(id);
          if (!run) {
            return [];
          }
          return [
            {
              costUsd: sums.costUsd,
              externalTicketId: run.workRequest?.externalTicketId ?? null,
              inputTokens: sums.inputTokens,
              outputTokens: sums.outputTokens,
              runId: run.id,
              startedAt: run.startedAt,
              status: run.status,
              templateName: run.template.name,
            },
          ];
        }),
        totals: toBucket(totals),
        // Spend from workflows that keep no run: authoring, scheduled evals,
        // lesson consolidation, dependency inference, epic planning.
        unattributed: {
          calls: unattributed._count._all + (rolledUnattributed._sum.calls ?? 0),
          costUsd: (unattributed._sum.costUsd ?? 0) + Number(rolledUnattributed._sum.costUsd ?? 0),
        },
        until: until.toISOString(),
        windowDays,
      },
    };
  }
};
