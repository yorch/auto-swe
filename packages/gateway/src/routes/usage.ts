import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { asPlatformAdmin } from '../lib/platformAdminScope.js';
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
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * The gateway's pg pool holds 10 connections. At most four window-wide queries
 * run together, then the per-day aggregates this many at a time, so one report
 * never holds the whole pool against auth and webhook traffic.
 */
const DAILY_CONCURRENCY = 3;
const TOP_RUNS = 10;

const UsageQuery = z
  .object({
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

/** Add a group to each accumulator, leaving its failed calls out of latency. */
function addGroup(accs: Acc[], g: Group, failed: Group | undefined): void {
  for (const a of accs) {
    a.calls += g._count._all;
    a.costUsd += g._sum.costUsd ?? 0;
    a.errors += failed?._count._all ?? 0;
    a.inputTokens += g._sum.inputTokens ?? 0;
    a.outputTokens += g._sum.outputTokens ?? 0;
    a.okDurationMs += (g._sum.durationMs ?? 0) - (failed?._sum.durationMs ?? 0);
    a.okDurationCount += g._count.durationMs - (failed?._count.durationMs ?? 0);
  }
}

/** Start of the UTC day `ms` falls in. */
function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    })
  );
  return out;
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

export const usageRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const prisma = fastify.prisma;

  app.get(
    '/usage',
    {
      onRequest: requireAuth(),
      schema: { querystring: UsageQuery },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { orgId, teamId, window: windowDays } = request.query;
      const scope: UsageScope = teamId ? { teamId } : orgId ? { orgId } : {};
      if (!(await mayReadUsage(prisma, user, scope))) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message:
              'The platform-wide report is ADMIN-only; a team LEAD may read their team, an ORG_ADMIN their organization',
          },
        });
      }
      // Whole UTC days, closed at the end of today, so every query covers
      // exactly the rows the daily bars do — including a request that runs
      // across midnight.
      const until = new Date(utcDayStart(Date.now()) + DAY_MS);
      const since = new Date(until.getTime() - windowDays * DAY_MS);
      const llm = { ...scope, createdAt: { gte: since, lt: until }, type: 'llm_response' };

      // One grouping by (model, agent, activity) serves the totals and all
      // three breakdowns: the key space is small, and it saves a full-window
      // scan per breakdown.
      const [groups, failedGroups, unattributed, topRunGroups] = await asPlatformAdmin(
        user,
        PLATFORM_WIDE,
        ['AgentTrace'],
        () =>
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
              orderBy: { _sum: { costUsd: 'desc' } },
              take: TOP_RUNS,
              where: { ...llm, costUsd: { gt: 0 }, runId: { not: null } },
            }),
          ])
      );

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
      for (const g of groups) {
        addGroup(
          [totals, into(byModel, g.model), into(byAgent, g.agentKey), into(byActivity, g.nodeId)],
          g,
          failedByKey.get(keyOf(g))
        );
      }

      // Per tenant, in a second batch so the report never holds more than four
      // pool connections at once.
      const [tenantGroups, failedTenantGroups] = await asPlatformAdmin(
        user,
        PLATFORM_WIDE,
        ['AgentTrace'],
        () =>
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
      );
      const tenantKey = (g: { teamId: string | null; orgId: string | null }) =>
        JSON.stringify([g.teamId, g.orgId]);
      const failedByTenant = new Map(failedTenantGroups.map((g) => [tenantKey(g), g]));
      const byTeam = new Map<string | null, Acc>();
      const teamOrg = new Map<string | null, string | null>();
      const byOrg = new Map<string | null, Acc>();
      for (const g of tenantGroups) {
        teamOrg.set(g.teamId, g.orgId);
        addGroup(
          [into(byTeam, g.teamId), into(byOrg, g.orgId)],
          g,
          failedByTenant.get(tenantKey(g))
        );
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

      const days = Array.from({ length: windowDays }, (_, i) => since.getTime() + i * DAY_MS);
      const daily = await mapLimited(days, DAILY_CONCURRENCY, async (start) => {
        const row = await asPlatformAdmin(user, PLATFORM_WIDE, ['AgentTrace'], () =>
          prisma.agentTrace.aggregate({
            _count: { _all: true },
            _sum: { costUsd: true, inputTokens: true, outputTokens: true },
            where: {
              ...scope,
              createdAt: { gte: new Date(start), lt: new Date(start + DAY_MS) },
              type: 'llm_response',
            },
          })
        );
        return {
          calls: row._count._all,
          costUsd: row._sum.costUsd ?? 0,
          date: new Date(start).toISOString().slice(0, 10),
          inputTokens: row._sum.inputTokens ?? 0,
          outputTokens: row._sum.outputTokens ?? 0,
        };
      });

      const runIds = topRunGroups.flatMap((g) => (g.runId ? [g.runId] : []));
      const runs = runIds.length
        ? await prisma.workflowRun.findMany({
            select: {
              id: true,
              startedAt: true,
              status: true,
              template: { select: { name: true } },
              workRequest: { select: { externalTicketId: true } },
            },
            where: { id: { in: runIds } },
          })
        : [];
      const runById = new Map(runs.map((r) => [r.id, r]));

      const ranked = <K, L extends object>(m: Map<K, Acc>, label: (k: K) => L) =>
        [...m.entries()]
          .map(([k, a]) => ({ ...label(k), ...toBucket(a) }))
          .sort((a, b) => b.costUsd - a.costUsd);

      return {
        data: {
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
          daily,
          scope,
          since: since.toISOString(),
          // Ranked by spend inside the window, which for a run that started
          // before it is only part of its cost.
          topRuns: topRunGroups.flatMap((g) => {
            const run = g.runId ? runById.get(g.runId) : undefined;
            if (!run) {
              return [];
            }
            return [
              {
                costUsd: g._sum.costUsd ?? 0,
                externalTicketId: run.workRequest?.externalTicketId ?? null,
                inputTokens: g._sum.inputTokens ?? 0,
                outputTokens: g._sum.outputTokens ?? 0,
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
            calls: unattributed._count._all,
            costUsd: unattributed._sum.costUsd ?? 0,
          },
          until: until.toISOString(),
          windowDays,
        },
      };
    }
  );
};
