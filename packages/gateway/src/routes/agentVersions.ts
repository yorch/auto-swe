import { DAY_MS, rollupHorizonMs } from '@auto-swe/shared/lib/agentTraceRollup';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { toImplementerRuntime, toReasoningLevel } from '@auto-swe/shared/types/api';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AgentInactiveError,
  type AgentScope,
  AgentVersionConflictError,
  modelRequiredError,
  updateAgent,
  validateCredentialRef,
  validateMcpConnectionRef,
} from '../lib/agentLibraryService.js';
import { writeAuditLog } from '../lib/auditLog.js';
import { customRangeFields, refineCustomRange, resolveWindow } from '../lib/dateWindow.js';
import { sendError } from '../lib/httpErrors.js';
import { coveredRollupDays, planWindow, timeWhere } from '../lib/usageWindows.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/**
 * Version history of one Agent lineage (a key at a scope), and restoring an old version.
 *
 *   GET  /api/v1/platform/agent-library/:id/versions        every version, newest first
 *   GET  /api/v1/platform/agent-library/:id/version-stats   LLM usage per (version, model)
 *   POST /api/v1/platform/agent-library/:id/restore    cut a NEW version from an old one
 *
 * `:id` is any version of the lineage. A restore never rewrites history: it copies the chosen
 * version's content into a new highest version, so runs pinned to any earlier version keep
 * resolving it.
 */

const IdParams = z.object({ id: z.string().uuid() });

const STATS_WINDOWS = [7, 30, 90] as const;
/** Rows read per grouped query: (version x model) groups are few; runs are the unbounded axis. */
const STATS_GROUP_CAP = 2000;
const STATS_RUN_CAP = 20_000;
const StatsQuery = refineCustomRange(
  z.object({
    ...customRangeFields,
    window: z.coerce
      .number()
      .int()
      .refine((n) => (STATS_WINDOWS as readonly number[]).includes(n), {
        message: `window must be one of ${STATS_WINDOWS.join(', ')}`,
      })
      .default(30),
  })
);
const STATS_REASON = 'an ADMIN reads one agent lineage’s LLM usage across every tenant';

interface StatsAcc {
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  okDurationMs: number;
  okDurationCount: number;
  runs: Set<string>;
}

const num = (v: bigint | number | { toNumber(): number } | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === 'object' ? v.toNumber() : Number(v);

const RestoreBody = z.object({ versionId: z.string().uuid() });

const WITH_SKILLS = {
  skillRefs: {
    include: { skill: { select: { id: true, name: true } } },
    orderBy: { sortOrder: 'asc' as const },
  },
};

export const agentVersionRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });

  const lineageWhere = (a: {
    key: string;
    scope: string;
    teamId: string | null;
    orgId: string | null;
    channelId: string | null;
    workflowTemplateId: string | null;
  }) => ({
    channelId: a.channelId,
    key: a.key,
    orgId: a.orgId,
    scope: a.scope as AgentScope,
    teamId: a.teamId,
    workflowTemplateId: a.workflowTemplateId,
  });

  app.get(
    '/agent-library/:id/versions',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const agent = await fastify.prisma.agent.findUnique({ where: { id: request.params.id } });
      if (!agent) {
        return sendError(reply, 404, 'NOT_FOUND', 'Agent not found');
      }
      const versions = await runUnscoped(
        'admin reads the version history of one agent lineage at any scope',
        ['Agent'],
        () =>
          fastify.prisma.agent.findMany({
            include: WITH_SKILLS,
            orderBy: { version: 'desc' },
            where: lineageWhere(agent),
          })
      );
      const authorIds = [
        ...new Set(versions.map((v) => v.createdById).filter(Boolean)),
      ] as string[];
      const authors =
        authorIds.length > 0
          ? await fastify.prisma.user.findMany({
              select: { email: true, id: true },
              where: { id: { in: authorIds } },
            })
          : [];
      const emailById = new Map(authors.map((u) => [u.id, u.email]));
      return {
        data: versions.map((v) => ({
          ...v,
          createdByEmail: v.createdById ? (emailById.get(v.createdById) ?? null) : null,
        })),
      };
    }
  );

  /**
   * LLM usage of one lineage, per (Agent version, model), over a window of whole UTC days.
   *
   * The rows come from `agent_traces.agent_id`, which every instrumented LLM call stamps with the
   * `Agent` row it resolved, so it counts what actually ran (a scoped override or an explicit
   * `key@version` ref included), not the GLOBAL snapshot a run pins. Completed days are read from
   * the daily rollup, which carries the same key; the trailing days and any day without a rollup
   * from the live traces, as the usage report does. Calls with no recorded agent (rows from
   * before the column, and call sites with no `Agent` row) are returned apart as `unrecorded`,
   * matched on the lineage's key only: they cannot be told from other lineages of that key.
   *
   * A description of what ran, not a comparison: runs that used different versions also differ
   * in template, repository and the agents around this one.
   */
  app.get(
    '/agent-library/:id/version-stats',
    { onRequest: adminOnly, schema: { params: IdParams, querystring: StatsQuery } },
    async (request, reply) => {
      const anchor = await fastify.prisma.agent.findUnique({ where: { id: request.params.id } });
      if (!anchor) {
        return sendError(reply, 404, 'NOT_FOUND', 'Agent not found');
      }
      const lineage = await runUnscoped(
        'admin reads the version history of one agent lineage at any scope',
        ['Agent'],
        () =>
          fastify.prisma.agent.findMany({
            orderBy: { version: 'desc' },
            select: { id: true, scope: true, version: true },
            where: lineageWhere(anchor),
          })
      );
      const byId = new Map(lineage.map((a) => [a.id, a]));

      const now = Date.now();
      const {
        days: windowDays,
        end: until,
        start: since,
      } = resolveWindow(request.query, request.query.window, now);
      const covered = await coveredRollupDays(
        fastify.prisma,
        since.getTime(),
        until.getTime(),
        now
      );
      const plan = planWindow(since.getTime(), until.getTime(), covered, rollupHorizonMs(now));

      // This lineage's rows, plus the rows of this key that name no agent at all.
      const mine = [{ agentId: { in: [...byId.keys()] } }, { agentId: null, agentKey: anchor.key }];
      const liveWhere = { AND: [{ type: 'llm_response' }, timeWhere(plan.live), { OR: mine }] };
      const rolledWhere = { day: { in: plan.rollupDays }, OR: mine };
      // NULLs first: the unrecorded bucket is a handful of groups and must not be the first thing a
      // cap cuts (Postgres sorts NULLs last ascending); a cut drops the tail of the (agent id, model) order.
      const ordered = [
        { agentId: { nulls: 'first' as const, sort: 'asc' as const } },
        { model: 'asc' as const },
      ];

      // Two batches of at most three queries: the gateway's pg pool holds 10 connections.
      const { live, rolled } = await runUnscoped(
        STATS_REASON,
        ['AgentTrace', 'AgentTraceDailyUsage'],
        async () => {
          const live = plan.live.length
            ? await Promise.all([
                fastify.prisma.agentTrace.groupBy({
                  _count: { _all: true, durationMs: true },
                  _sum: { costUsd: true, durationMs: true, inputTokens: true, outputTokens: true },
                  by: ['agentId', 'model'],
                  orderBy: ordered,
                  take: STATS_GROUP_CAP + 1,
                  where: liveWhere,
                }),
                fastify.prisma.agentTrace.groupBy({
                  _count: { _all: true, durationMs: true },
                  _sum: { durationMs: true },
                  by: ['agentId', 'model'],
                  orderBy: ordered,
                  take: STATS_GROUP_CAP + 1,
                  where: { AND: [liveWhere, { error: { not: null } }] },
                }),
                fastify.prisma.agentTrace.groupBy({
                  by: ['agentId', 'model', 'runId'],
                  orderBy: [...ordered, { runId: 'asc' }],
                  take: STATS_RUN_CAP + 1,
                  where: { AND: [liveWhere, { runId: { not: null } }] },
                }),
              ])
            : null;
          const rolled = plan.rollupDays.length
            ? await Promise.all([
                fastify.prisma.agentTraceDailyUsage.groupBy({
                  _sum: {
                    calls: true,
                    costUsd: true,
                    errors: true,
                    inputTokens: true,
                    okDurationCount: true,
                    okDurationMs: true,
                    outputTokens: true,
                  },
                  by: ['agentId', 'model'],
                  orderBy: ordered,
                  take: STATS_GROUP_CAP + 1,
                  where: rolledWhere,
                }),
                fastify.prisma.agentTraceDailyUsage.groupBy({
                  by: ['agentId', 'model', 'runId'],
                  orderBy: [...ordered, { runId: 'asc' }],
                  take: STATS_RUN_CAP + 1,
                  where: { ...rolledWhere, runId: { not: null } },
                }),
              ])
            : null;
          return { live, rolled };
        }
      );

      const keyOf = (g: { agentId: string | null; model: string | null }) =>
        JSON.stringify([g.agentId, g.model]);
      const accs = new Map<string, StatsAcc & { agentId: string | null; model: string | null }>();
      const acc = (g: { agentId: string | null; model: string | null }) => {
        const k = keyOf(g);
        let a = accs.get(k);
        if (!a) {
          a = {
            agentId: g.agentId,
            calls: 0,
            costUsd: 0,
            errors: 0,
            inputTokens: 0,
            model: g.model,
            okDurationCount: 0,
            okDurationMs: 0,
            outputTokens: 0,
            runs: new Set(),
          };
          accs.set(k, a);
        }
        return a;
      };
      let groupsTruncated = false;
      let runsTruncated = false;
      if (live) {
        const [totals, failed, runs] = live;
        const failedByKey = new Map(failed.map((g) => [keyOf(g), g]));
        groupsTruncated ||= totals.length > STATS_GROUP_CAP || failed.length > STATS_GROUP_CAP;
        runsTruncated ||= runs.length > STATS_RUN_CAP;
        for (const g of totals.slice(0, STATS_GROUP_CAP)) {
          const f = failedByKey.get(keyOf(g));
          const a = acc(g);
          a.calls += g._count._all;
          a.errors += f?._count._all ?? 0;
          a.inputTokens += num(g._sum.inputTokens);
          a.outputTokens += num(g._sum.outputTokens);
          a.costUsd += num(g._sum.costUsd);
          a.okDurationMs += num(g._sum.durationMs) - num(f?._sum.durationMs);
          a.okDurationCount += g._count.durationMs - (f?._count.durationMs ?? 0);
        }
        for (const r of runs.slice(0, STATS_RUN_CAP)) {
          if (r.runId) {
            acc(r).runs.add(r.runId);
          }
        }
      }
      if (rolled) {
        const [totals, runs] = rolled;
        groupsTruncated ||= totals.length > STATS_GROUP_CAP;
        runsTruncated ||= runs.length > STATS_RUN_CAP;
        for (const g of totals.slice(0, STATS_GROUP_CAP)) {
          const a = acc(g);
          a.calls += num(g._sum.calls);
          a.errors += num(g._sum.errors);
          a.inputTokens += num(g._sum.inputTokens);
          a.outputTokens += num(g._sum.outputTokens);
          a.costUsd += num(g._sum.costUsd);
          a.okDurationMs += num(g._sum.okDurationMs);
          a.okDurationCount += num(g._sum.okDurationCount);
        }
        for (const r of runs.slice(0, STATS_RUN_CAP)) {
          if (r.runId) {
            acc(r).runs.add(r.runId);
          }
        }
      }

      const toRow = (a: StatsAcc & { agentId: string | null; model: string | null }) => {
        const version = a.agentId ? byId.get(a.agentId) : undefined;
        return {
          agentId: a.agentId,
          agentVersion: version?.version ?? null,
          avgDurationMs: a.okDurationCount > 0 ? a.okDurationMs / a.okDurationCount : null,
          calls: a.calls,
          costUsd: a.costUsd,
          distinctRuns: a.runs.size,
          errors: a.errors,
          inputTokens: a.inputTokens,
          model: a.model,
          outputTokens: a.outputTokens,
          scope: version?.scope ?? null,
        };
      };
      const all = [...accs.values()].map(toRow);
      const byModel = (x: { model: string | null }, y: { model: string | null }) =>
        (x.model ?? '').localeCompare(y.model ?? '');
      return {
        data: {
          groupsTruncated,
          isTruncated: groupsTruncated || runsTruncated,
          key: anchor.key,
          rows: all
            .filter((r) => r.agentId !== null)
            .sort((x, y) => (y.agentVersion ?? 0) - (x.agentVersion ?? 0) || byModel(x, y)),
          runsTruncated,
          scope: anchor.scope,
          since: since.toISOString().slice(0, 10),
          unrecorded: all.filter((r) => r.agentId === null).sort(byModel),
          until: new Date(until.getTime() - DAY_MS).toISOString().slice(0, 10),
          windowDays,
        },
      };
    }
  );

  app.post(
    '/agent-library/:id/restore',
    { onRequest: adminOnly, schema: { body: RestoreBody, params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const anchor = await fastify.prisma.agent.findUnique({ where: { id: request.params.id } });
      if (!anchor) {
        return sendError(reply, 404, 'NOT_FOUND', 'Agent not found');
      }
      const where = lineageWhere(anchor);
      const source = await fastify.prisma.agent.findFirst({
        include: WITH_SKILLS,
        where: { ...where, id: request.body.versionId },
      });
      if (!source) {
        return sendError(reply, 404, 'NOT_FOUND', 'That version does not belong to this agent');
      }
      const latest = await fastify.prisma.agent.findFirst({
        orderBy: { version: 'desc' },
        where,
      });
      if (!latest) {
        return sendError(reply, 404, 'NOT_FOUND', 'Agent not found');
      }
      // Restoring into a deactivated lineage would silently switch the agent back on, which is
      // a decision of its own; reactivate it deliberately first.
      if (!latest.isActive) {
        return sendError(
          reply,
          409,
          'AGENT_INACTIVE',
          'This agent is deactivated. Reactivate it before restoring a version.'
        );
      }
      // A version cut before a model was required may name neither field; restoring it would
      // make every run that resolves the agent throw, so refuse as create and edit do.
      const modelError = modelRequiredError(source, true);
      if (modelError) {
        return sendError(reply, 400, 'MODEL_REQUIRED', modelError);
      }
      // The same reference check an edit gets: the connection may have been deactivated or
      // belong to another team since that version was current.
      const mcpError = await validateMcpConnectionRef(fastify.prisma, source.mcpConnectionId, {
        scope: anchor.scope as AgentScope,
        teamId: anchor.teamId,
      });
      if (mcpError) {
        return sendError(reply, 400, 'INVALID_MCP_CONNECTION', mcpError);
      }
      // The pinned credential may have been deleted, or the version may predate the check.
      const credentialError = await validateCredentialRef(
        fastify.prisma,
        source.credentialId,
        source.modelSpec,
        { orgId: anchor.orgId, scope: anchor.scope as AgentScope, teamId: anchor.teamId }
      );
      if (credentialError) {
        return sendError(reply, 400, 'INVALID_CREDENTIAL', credentialError);
      }
      // A skill deactivated since then is not injected into the agent; say so rather than refuse.
      const inactiveSkills =
        source.skillRefs.length > 0
          ? await runUnscoped(
              'admin checks the skills one agent version already references, at any scope',
              ['Skill'],
              () =>
                fastify.prisma.skill.findMany({
                  select: { name: true },
                  where: { id: { in: source.skillRefs.map((r) => r.skillId) }, isActive: false },
                })
            )
          : [];
      let saved: Awaited<ReturnType<typeof updateAgent>>;
      try {
        saved = await updateAgent(
          fastify.prisma,
          latest,
          {
            credentialId: source.credentialId,
            description: source.description,
            inheritsModelFrom: source.inheritsModelFrom,
            mcpConnectionId: source.mcpConnectionId,
            modelSpec: source.modelSpec,
            name: source.name,
            reasoning: toReasoningLevel(source.reasoning),
            // Restore is admin-only, so it may restore the runtime too.
            runtime: toImplementerRuntime(source.runtime),
            skillRefs: source.skillRefs.map((r) => ({
              skillId: r.skillId,
              sortOrder: r.sortOrder,
            })),
            // An unchanged prompt is left out so restoring other fields keeps verification.
            ...(source.systemPrompt !== latest.systemPrompt
              ? { systemPrompt: source.systemPrompt }
              : {}),
            toolKeys: (source.toolKeys as string[] | null) ?? null,
          },
          actor.sub
        );
      } catch (err) {
        // Another edit or restore cut the next version first.
        if (err instanceof AgentVersionConflictError) {
          return sendError(reply, 409, 'AGENT_CHANGED', err.message);
        }
        // A deactivation that landed after this route's own active check: the service refuses it
        // under the lineage's lock, and the reason is the operator's to act on, not a 500.
        if (err instanceof AgentInactiveError) {
          return sendError(reply, 409, 'AGENT_INACTIVE', err.message);
        }
        throw err;
      }
      const { agent, catalogWarnings, credentialWarnings, scanWarnings } = saved;
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: { restoredFromVersion: source.version, version: agent.version },
        before: { version: latest.version },
        entityId: agent.id,
        entityType: 'Agent',
      });
      return reply.status(201).send({
        data: agent,
        ...(scanWarnings.length > 0 ? { scanWarnings } : {}),
        ...(catalogWarnings.length > 0 ? { catalogWarnings } : {}),
        ...(credentialWarnings.length > 0 ? { credentialWarnings } : {}),
        ...(inactiveSkills.length > 0
          ? {
              skillWarnings: inactiveSkills.map(
                (sk) => `The skill "${sk.name}" is deactivated and will not apply to this agent.`
              ),
            }
          : {}),
      });
    }
  );
};
