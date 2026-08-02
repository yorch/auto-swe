import type { Prisma } from '@auto-swe/shared';
import { currentYearMonth } from '@auto-swe/shared/lib/billing';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { asPlatformAdmin } from '../lib/platformAdminScope.js';
import { type JwtPayload, requireAuth, requireUser } from '../plugins/auth.js';
import { CRON_5_FIELD_RE } from './scheduledWorkRequests.js';

/**
 * SlackChannel admin management (channel assistant, Phase 1). Phase 0 auto-provisions a
 * channel on the first @mention (see routes/slack.ts `provisionChannel`); this
 * surface lets admins register/retune channels explicitly: which Agent drives
 * the channel, ambient mode + cron, the per-channel budget cap, and the owning
 * team (which governs the team tier of the config cascade + RBAC).
 *
 * RBAC: writes (POST/PATCH/DELETE) require the platform ADMIN role. Reads are
 * open to any authenticated user but filtered to channels on teams the caller
 * belongs to (admins see all) — mirrors routes/lessons.ts.
 */

const CRON_MESSAGE =
  'must be a 5-field cron expression (minute hour day-of-month month day-of-week) using numbers, *, ranges, steps and lists only';

const IdParams = z.object({ id: z.string().uuid() });

const MemoryParams = z.object({
  id: z.string().uuid(),
  memoryId: z.string().uuid(),
});

const MemoryQuery = z.object({
  includeConsolidated: z.enum(['true', 'false']).optional(),
});

const CreateChannelSchema = z.object({
  agentKey: z.string().min(1).max(100).optional(),
  ambientCron: z.string().regex(CRON_5_FIELD_RE, CRON_MESSAGE).nullable().optional(),
  ambientEnabled: z.boolean().optional(),
  consolidationEnabled: z.boolean().optional(),
  consolidationMinClusterSize: z.number().int().min(2).max(50).nullable().optional(),
  consolidationSimilarityThreshold: z.number().min(0).max(1).nullable().optional(),
  followupSessionEnabled: z.boolean().optional(),
  isPrivate: z.boolean().optional(),
  monthlyBudgetUsdCents: z.number().int().min(0).nullable().optional(),
  name: z.string().min(1).max(200).nullable().optional(),
  orgFlaggingEnabled: z.boolean().optional(),
  passiveIngestEnabled: z.boolean().optional(),
  personaPrompt: z.string().max(2000).nullable().optional(),
  reactiveCron: z.string().regex(CRON_5_FIELD_RE, CRON_MESSAGE).nullable().optional(),
  reactiveEnabled: z.boolean().optional(),
  slackChannelId: z.string().min(1).max(50),
  slackTeamId: z.string().min(1).max(50),
  teamId: z.string().uuid(),
});

/** PATCH /:id/memory/:memoryId body. At least one text field must be present
 * (a no-field edit is meaningless and would needlessly fire a re-embed). */
const UpdateMemorySchema = z
  .object({
    lessonSummary: z.string().min(1).optional(),
    rationale: z.string().min(1).optional(),
  })
  .refine((b) => b.lessonSummary !== undefined || b.rationale !== undefined, {
    message: 'Provide at least one of lessonSummary or rationale',
  });

const UpdateChannelSchema = z.object({
  agentKey: z.string().min(1).max(100).optional(),
  ambientCron: z.string().regex(CRON_5_FIELD_RE, CRON_MESSAGE).nullable().optional(),
  ambientEnabled: z.boolean().optional(),
  consolidationEnabled: z.boolean().optional(),
  consolidationMinClusterSize: z.number().int().min(2).max(50).nullable().optional(),
  consolidationSimilarityThreshold: z.number().min(0).max(1).nullable().optional(),
  followupSessionEnabled: z.boolean().optional(),
  isActive: z.boolean().optional(),
  isPrivate: z.boolean().optional(),
  monthlyBudgetUsdCents: z.number().int().min(0).nullable().optional(),
  name: z.string().min(1).max(200).nullable().optional(),
  openItemNudgeAfterHours: z.number().int().min(1).nullable().optional(),
  openItemNudgeCooldownHours: z.number().int().min(1).nullable().optional(),
  orgFlagCooldownHours: z.number().int().min(1).nullable().optional(),
  orgFlaggingEnabled: z.boolean().optional(),
  passiveIngestEnabled: z.boolean().optional(),
  personaPrompt: z.string().max(2000).nullable().optional(),
  reactiveCooldownMinutes: z.number().int().min(1).nullable().optional(),
  reactiveCron: z.string().regex(CRON_5_FIELD_RE, CRON_MESSAGE).nullable().optional(),
  reactiveEnabled: z.boolean().optional(),
  reactiveLookbackMinutes: z.number().int().min(1).nullable().optional(),
  teamId: z.string().uuid().optional(),
});

const channelInclude = {
  workspace: { select: { id: true, name: true, orgId: true, slackTeamId: true } },
} as const;

type ChannelRow = Prisma.SlackChannelGetPayload<{ include: typeof channelInclude }>;
type UsageRow = Prisma.ChannelMonthlyUsageGetPayload<true>;

/** Serialize a ChannelMonthlyUsage row (Decimal → number) to the API shape, or null. */
function serializeUsage(usage: UsageRow | null) {
  return usage
    ? {
        costUsdAccrued: Number(usage.costUsdAccrued),
        runsCompleted: usage.runsCompleted,
        yearMonth: usage.yearMonth,
      }
    : null;
}

/** Attach this month's ChannelMonthlyUsage row (or null) to a serialized channel. */
async function withCurrentUsage(fastify: FastifyInstance, row: ChannelRow) {
  const usage = await fastify.prisma.channelMonthlyUsage.findUnique({
    where: { channelId_yearMonth: { channelId: row.id, yearMonth: currentYearMonth() } },
  });
  return { ...row, currentMonthUsage: serializeUsage(usage) };
}

/** Map a create/update body to the SlackChannel writable fields. Each field is
 * spread only when present so PATCH leaves untouched fields alone; nullable
 * fields preserve explicit-null clears (`null` is "present"). */
function channelWritableData(body: {
  agentKey?: string;
  ambientCron?: string | null;
  ambientEnabled?: boolean;
  consolidationEnabled?: boolean;
  consolidationMinClusterSize?: number | null;
  consolidationSimilarityThreshold?: number | null;
  followupSessionEnabled?: boolean;
  isActive?: boolean;
  isPrivate?: boolean;
  monthlyBudgetUsdCents?: number | null;
  name?: string | null;
  openItemNudgeAfterHours?: number | null;
  openItemNudgeCooldownHours?: number | null;
  orgFlagCooldownHours?: number | null;
  orgFlaggingEnabled?: boolean;
  passiveIngestEnabled?: boolean;
  personaPrompt?: string | null;
  reactiveCooldownMinutes?: number | null;
  reactiveCron?: string | null;
  reactiveEnabled?: boolean;
  reactiveLookbackMinutes?: number | null;
}) {
  return {
    ...(body.agentKey !== undefined ? { agentKey: body.agentKey } : {}),
    ...(body.ambientCron !== undefined ? { ambientCron: body.ambientCron } : {}),
    ...(body.ambientEnabled !== undefined ? { ambientEnabled: body.ambientEnabled } : {}),
    ...(body.consolidationEnabled !== undefined
      ? { consolidationEnabled: body.consolidationEnabled }
      : {}),
    ...(body.consolidationMinClusterSize !== undefined
      ? { consolidationMinClusterSize: body.consolidationMinClusterSize }
      : {}),
    ...(body.consolidationSimilarityThreshold !== undefined
      ? { consolidationSimilarityThreshold: body.consolidationSimilarityThreshold }
      : {}),
    ...(body.followupSessionEnabled !== undefined
      ? { followupSessionEnabled: body.followupSessionEnabled }
      : {}),
    ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
    ...(body.isPrivate !== undefined ? { isPrivate: body.isPrivate } : {}),
    ...(body.monthlyBudgetUsdCents !== undefined
      ? { monthlyBudgetUsdCents: body.monthlyBudgetUsdCents }
      : {}),
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.openItemNudgeAfterHours !== undefined
      ? { openItemNudgeAfterHours: body.openItemNudgeAfterHours }
      : {}),
    ...(body.openItemNudgeCooldownHours !== undefined
      ? { openItemNudgeCooldownHours: body.openItemNudgeCooldownHours }
      : {}),
    ...(body.orgFlagCooldownHours !== undefined
      ? { orgFlagCooldownHours: body.orgFlagCooldownHours }
      : {}),
    ...(body.orgFlaggingEnabled !== undefined
      ? { orgFlaggingEnabled: body.orgFlaggingEnabled }
      : {}),
    ...(body.passiveIngestEnabled !== undefined
      ? { passiveIngestEnabled: body.passiveIngestEnabled }
      : {}),
    ...(body.personaPrompt !== undefined ? { personaPrompt: body.personaPrompt } : {}),
    ...(body.reactiveCooldownMinutes !== undefined
      ? { reactiveCooldownMinutes: body.reactiveCooldownMinutes }
      : {}),
    ...(body.reactiveCron !== undefined ? { reactiveCron: body.reactiveCron } : {}),
    ...(body.reactiveEnabled !== undefined ? { reactiveEnabled: body.reactiveEnabled } : {}),
    ...(body.reactiveLookbackMinutes !== undefined
      ? { reactiveLookbackMinutes: body.reactiveLookbackMinutes }
      : {}),
  };
}

/**
 * Reconcile a channel's Temporal Schedule (ambient or reactive) with the current
 * row state. A schedule should exist iff the channel is active, the mode is
 * enabled, and a cron expression is set. Best-effort: a Temporal hiccup is logged
 * and swallowed so it never fails the CRUD response (re-syncs on next save).
 */
async function reconcileSchedule(
  fastify: FastifyInstance,
  request: { log: FastifyInstance['log'] },
  channelId: string,
  isActive: boolean,
  enabled: boolean,
  cron: string | null,
  mode: 'ambient' | 'reactive'
): Promise<void> {
  try {
    if (isActive && enabled && cron) {
      if (mode === 'ambient') {
        await fastify.temporal.syncChannelAmbientSchedule({ channelId, cronExpression: cron });
      } else {
        await fastify.temporal.syncChannelReactiveSchedule({ channelId, cronExpression: cron });
      }
    } else {
      if (mode === 'ambient') {
        await fastify.temporal.deleteChannelAmbientSchedule(channelId);
      } else {
        await fastify.temporal.deleteChannelReactiveSchedule(channelId);
      }
    }
  } catch (err) {
    request.log.error({ channelId, err }, `failed to reconcile channel ${mode} schedule`);
  }
}

/**
 * Channel-access guard mirroring lib/orgAccess.ts `assertOrgAccess`: platform
 * ADMINs see all channels; everyone else needs a TeamMembership on the channel's
 * owning team. Sends a 404 (not 403 — don't leak channel existence) and returns
 * `false` when the check fails; returns `true` on success.
 */
async function assertChannelAccess(
  fastify: FastifyInstance,
  user: JwtPayload,
  teamId: string,
  reply: FastifyReply
): Promise<boolean> {
  if (user.role === 'ADMIN') {
    return true;
  }
  const member = await fastify.prisma.teamMembership.findUnique({
    where: { userId_teamId: { teamId, userId: user.sub } },
  });
  if (!member) {
    await reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Channel not found' } });
    return false;
  }
  return true;
}

export const slackChannelRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });
  const authed = requireAuth({ requiredRole: 'ENGINEER' });

  // GET / — list channels. Admins see all; everyone else sees channels whose
  // owning team they belong to.
  app.get('/', { onRequest: authed }, async (request) => {
    const user = requireUser(request);
    const where: Prisma.SlackChannelWhereInput =
      user.role === 'ADMIN' ? {} : { team: { memberships: { some: { userId: user.sub } } } };
    const rows = await asPlatformAdmin(
      user,
      "admin lists every team's channels",
      ['SlackChannel'],
      () =>
        fastify.prisma.slackChannel.findMany({
          include: channelInclude,
          orderBy: { createdAt: 'desc' },
          where,
        })
    );
    // Batch this month's usage for all listed channels in one query, then map
    // by channelId — avoids an N+1 (one findUnique per row).
    const usageRows = await fastify.prisma.channelMonthlyUsage.findMany({
      where: { channelId: { in: rows.map((r) => r.id) }, yearMonth: currentYearMonth() },
    });
    const usageByChannel = new Map(usageRows.map((u) => [u.channelId, u]));
    const data = rows.map((row) => ({
      ...row,
      currentMonthUsage: serializeUsage(usageByChannel.get(row.id) ?? null),
    }));
    return { data };
  });

  // GET /workspaces — list installed Slack workspaces with their install status
  // (Full multi-workspace). Admin-only; never returns the bot token itself, only
  // its masked last-four + install metadata. Static path, declared before `/:id`
  // so Fastify routes it as a literal (not a channel id).
  app.get('/workspaces', { onRequest: adminOnly }, async () => {
    const rows = await fastify.prisma.slackWorkspace.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        _count: { select: { channels: true } },
        botTokenLastFour: true,
        createdAt: true,
        id: true,
        installedAt: true,
        isActive: true,
        name: true,
        orgId: true,
        slackTeamId: true,
      },
    });
    const data = rows.map((r) => ({
      channelCount: r._count.channels,
      createdAt: r.createdAt,
      // `installed` is true only once the workspace completed the bot-install flow;
      // an event-provisioned workspace runs on the singleton fallback until then.
      installed: r.installedAt !== null,
      installedAt: r.installedAt,
      isActive: r.isActive,
      name: r.name,
      orgId: r.orgId,
      slackTeamId: r.slackTeamId,
      tokenLastFour: r.botTokenLastFour,
      workspaceId: r.id,
    }));
    return { data };
  });

  // GET /:id — one channel + workspace + current-month usage.
  app.get('/:id', { onRequest: authed, schema: { params: IdParams } }, async (request, reply) => {
    const user = requireUser(request);
    const row = await fastify.prisma.slackChannel.findUnique({
      include: channelInclude,
      where: { id: request.params.id },
    });
    if (!row) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Channel not found' } });
    }
    if (!(await assertChannelAccess(fastify, user, row.teamId, reply))) {
      return reply;
    }
    return { data: await withCurrentUsage(fastify, row) };
  });

  // GET /:id/budget — current-month usage + the cap.
  app.get(
    '/:id/budget',
    { onRequest: authed, schema: { params: IdParams } },
    async (request, reply) => {
      const user = requireUser(request);
      // The channel + its usage are independent reads — fetch in parallel
      // (matches orgBudget.ts).
      const [row, usage] = await Promise.all([
        fastify.prisma.slackChannel.findUnique({
          select: { id: true, monthlyBudgetUsdCents: true, name: true, teamId: true },
          where: { id: request.params.id },
        }),
        fastify.prisma.channelMonthlyUsage.findUnique({
          where: {
            channelId_yearMonth: { channelId: request.params.id, yearMonth: currentYearMonth() },
          },
        }),
      ]);
      if (!row) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Channel not found' } });
      }
      if (!(await assertChannelAccess(fastify, user, row.teamId, reply))) {
        return reply;
      }
      return {
        channelId: row.id,
        channelName: row.name,
        currentMonthUsage: serializeUsage(usage),
        monthlyBudgetUsdCents: row.monthlyBudgetUsdCents,
      };
    }
  );

  // GET /:id/memory — list this channel's memory items (channel assistant, Phase 2).
  // By default returns only active (un-consolidated) items. Pass
  // `?includeConsolidated=true` to include soft-deleted (consolidated) rows so
  // admins can inspect what the ambient consolidation pass merged together.
  //
  // NOTE: we deliberately select scalar fields explicitly and never the
  // `embedding` column — it's a Prisma `Unsupported("vector(1536)")` field that
  // can't be returned through the client. Editing `lessonSummary`/`rationale`
  // is handled by PATCH /:id/memory/:memoryId below, which updates the text and
  // fires a best-effort `ReembedMemoryWorkflow` so the pgvector embedding (a
  // worker/embeddings concern) catches up to the new text.
  app.get(
    '/:id/memory',
    { onRequest: authed, schema: { params: IdParams, querystring: MemoryQuery } },
    async (request, reply) => {
      const user = requireUser(request);
      const row = await fastify.prisma.slackChannel.findUnique({
        select: { id: true, teamId: true },
        where: { id: request.params.id },
      });
      if (!row) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Channel not found' } });
      }
      if (!(await assertChannelAccess(fastify, user, row.teamId, reply))) {
        return reply;
      }
      const showConsolidated = request.query.includeConsolidated === 'true';
      // Bounded to the single channel the caller was just authorised for. An
      // added `teamId` predicate would look stronger and is not: `MemoryItem`
      // denormalises the team at write time, so re-parenting a channel would
      // silently hide everything written under its old team.
      const items = await runUnscoped(
        'bounded to one pre-authorised channelId',
        ['MemoryItem'],
        () =>
          fastify.prisma.memoryItem.findMany({
            orderBy: { createdAt: 'desc' },
            select: {
              agentKey: true,
              consolidatedAt: true,
              createdAt: true,
              id: true,
              lessonSummary: true,
              metadata: true,
              rationale: true,
            },
            take: 200,
            where: {
              channelId: request.params.id,
              ...(showConsolidated ? {} : { consolidatedAt: null }),
            },
          })
      );
      return { data: items };
    }
  );

  // DELETE /:id/memory/:memoryId — delete one memory item (ADMIN only). Verify
  // the row exists AND belongs to this channel before deleting, so an admin
  // can't remove another channel's row via a mismatched path.
  app.delete(
    '/:id/memory/:memoryId',
    { onRequest: adminOnly, schema: { params: MemoryParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const item = await fastify.prisma.memoryItem.findUnique({
        select: {
          agentKey: true,
          channelId: true,
          createdAt: true,
          id: true,
          lessonSummary: true,
          rationale: true,
        },
        where: { id: request.params.memoryId },
      });
      if (!item || item.channelId !== request.params.id) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Memory item not found' } });
      }
      await fastify.prisma.memoryItem.delete({ where: { id: item.id } });
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor,
        // Capture the deleted content — the delete is irreversible (re-embedding
        // isn't available here), so the audit row is the only record of what was
        // removed.
        before: {
          agentKey: item.agentKey,
          channelId: item.channelId,
          createdAt: item.createdAt,
          lessonSummary: item.lessonSummary,
          rationale: item.rationale,
        },
        entityId: item.id,
        entityType: 'MemoryItem',
      });
      return reply.send({ data: { deleted: true } });
    }
  );

  // PATCH /:id/memory/:memoryId — edit a memory item's text (ADMIN only), then
  // re-embed so the pgvector embedding catches up to the new text. Verify the
  // row exists AND belongs to this channel before updating (mirrors DELETE).
  // The text update is synchronous; the re-embed is best-effort (a Temporal
  // hiccup must not fail the edit — the embedding re-syncs on a later edit or
  // out-of-band reaper).
  app.patch(
    '/:id/memory/:memoryId',
    { onRequest: adminOnly, schema: { body: UpdateMemorySchema, params: MemoryParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const body = request.body;
      const item = await fastify.prisma.memoryItem.findUnique({
        select: { channelId: true, id: true, lessonSummary: true, rationale: true },
        where: { id: request.params.memoryId },
      });
      if (!item || item.channelId !== request.params.id) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Memory item not found' } });
      }

      const updated = await fastify.prisma.memoryItem.update({
        data: {
          ...(body.lessonSummary !== undefined ? { lessonSummary: body.lessonSummary } : {}),
          ...(body.rationale !== undefined ? { rationale: body.rationale } : {}),
        },
        select: {
          agentKey: true,
          createdAt: true,
          id: true,
          lessonSummary: true,
          metadata: true,
          rationale: true,
        },
        where: { id: item.id },
      });

      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: { lessonSummary: updated.lessonSummary, rationale: updated.rationale },
        before: { lessonSummary: item.lessonSummary, rationale: item.rationale },
        entityId: item.id,
        entityType: 'MemoryItem',
      });

      // Best-effort re-embed. The base row id alone would REJECT_DUPLICATE on a
      // second edit, so append a per-edit suffix (Date.now() — the gateway is
      // normal Node) to keep the workflowId unique across successive edits.
      try {
        await fastify.temporal.startReembedMemory(`reembed-mem-${item.id}-${Date.now()}`, item.id);
      } catch (err) {
        request.log.error({ err, memoryId: item.id }, 'failed to start memory re-embed');
      }

      return reply.send({ data: updated });
    }
  );

  // POST / — register a channel (ADMIN only).
  app.post(
    '/',
    { onRequest: adminOnly, schema: { body: CreateChannelSchema } },
    async (request, reply) => {
      const actor = requireUser(request);
      const body = request.body;

      const team = await fastify.prisma.team.findUnique({
        select: { id: true, orgId: true },
        where: { id: body.teamId },
      });
      if (!team) {
        return reply.status(400).send({ error: { code: 'NOT_FOUND', message: 'Team not found' } });
      }

      // Upsert the workspace (org from the team), then create the channel. A
      // workspace is unique by slackTeamId across the platform; if it already
      // exists under a different org than the chosen team, the channel's orgId
      // would diverge from workspace.orgId — breaking org budget + the
      // ORGANIZATION config tier. Reject that mismatch.
      const workspace = await fastify.prisma.slackWorkspace.upsert({
        create: { orgId: team.orgId, slackTeamId: body.slackTeamId },
        update: {},
        where: { slackTeamId: body.slackTeamId },
      });
      if (workspace.orgId !== team.orgId) {
        return reply.status(400).send({
          error: {
            code: 'WORKSPACE_ORG_MISMATCH',
            message:
              'This Slack workspace already belongs to a different organization than the chosen team. Pick a team in the workspace’s org.',
          },
        });
      }

      const existing = await fastify.prisma.slackChannel.findUnique({
        where: {
          workspaceId_slackChannelId: {
            slackChannelId: body.slackChannelId,
            workspaceId: workspace.id,
          },
        },
      });
      if (existing) {
        return reply.status(409).send({
          error: { code: 'CONFLICT', message: 'Channel already registered for this workspace' },
        });
      }

      const row = await fastify.prisma.slackChannel.create({
        data: {
          ...channelWritableData(body),
          // Derived from the workspace's org (== team.orgId after the guard
          // above) so channel.orgId and workspace.orgId never diverge.
          orgId: workspace.orgId,
          slackChannelId: body.slackChannelId,
          teamId: team.id,
          workspaceId: workspace.id,
        },
        include: channelInclude,
      });

      await writeAuditLog(fastify, {
        action: 'CREATE',
        actor,
        after: { name: row.name, slackChannelId: row.slackChannelId, teamId: row.teamId },
        entityId: row.id,
        entityType: 'SlackChannel',
      });

      await Promise.all([
        reconcileSchedule(
          fastify,
          request,
          row.id,
          row.isActive,
          row.ambientEnabled,
          row.ambientCron,
          'ambient'
        ),
        reconcileSchedule(
          fastify,
          request,
          row.id,
          row.isActive,
          row.reactiveEnabled,
          row.reactiveCron,
          'reactive'
        ),
      ]);

      return reply.status(201).send({ data: await withCurrentUsage(fastify, row) });
    }
  );

  // PATCH /:id — update mutable fields (ADMIN only).
  app.patch(
    '/:id',
    { onRequest: adminOnly, schema: { body: UpdateChannelSchema, params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const body = request.body;
      const current = await fastify.prisma.slackChannel.findUnique({
        where: { id: request.params.id },
      });
      if (!current) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Channel not found' } });
      }

      // Re-validate the team when moving the channel; keep orgId in step.
      let nextOrgId = current.orgId;
      if (body.teamId !== undefined && body.teamId !== current.teamId) {
        const team = await fastify.prisma.team.findUnique({
          select: { id: true, orgId: true },
          where: { id: body.teamId },
        });
        if (!team) {
          return reply
            .status(400)
            .send({ error: { code: 'NOT_FOUND', message: 'Team not found' } });
        }
        nextOrgId = team.orgId;
      }

      const row = await fastify.prisma.slackChannel.update({
        data: {
          ...channelWritableData(body),
          ...(body.teamId !== undefined ? { orgId: nextOrgId, teamId: body.teamId } : {}),
        },
        include: channelInclude,
        where: { id: current.id },
      });

      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: { agentKey: row.agentKey, isActive: row.isActive, teamId: row.teamId },
        before: { agentKey: current.agentKey, isActive: current.isActive, teamId: current.teamId },
        entityId: row.id,
        entityType: 'SlackChannel',
      });

      await Promise.all([
        reconcileSchedule(
          fastify,
          request,
          row.id,
          row.isActive,
          row.ambientEnabled,
          row.ambientCron,
          'ambient'
        ),
        reconcileSchedule(
          fastify,
          request,
          row.id,
          row.isActive,
          row.reactiveEnabled,
          row.reactiveCron,
          'reactive'
        ),
      ]);

      return reply.send({ data: await withCurrentUsage(fastify, row) });
    }
  );

  // ── Open items (Gap C) ───────────────────────────────────────────────────

  const OpenItemParams = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });
  const OpenItemStatusSchema = z.object({
    status: z.enum(['OPEN', 'RESOLVED', 'DISMISSED']),
  });
  const OpenItemsQuery = z.object({
    status: z.enum(['OPEN', 'RESOLVED', 'DISMISSED', 'all']).optional(),
  });

  // GET /:id/open-items — list open items for a channel.
  app.get(
    '/:id/open-items',
    { onRequest: authed, schema: { params: IdParams, querystring: OpenItemsQuery } },
    async (request, reply) => {
      const user = requireUser(request);
      const channel = await fastify.prisma.slackChannel.findUnique({
        select: { teamId: true },
        where: { id: request.params.id },
      });
      if (!channel) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Channel not found' } });
      }
      if (!(await assertChannelAccess(fastify, user, channel.teamId, reply))) {
        return reply;
      }
      const statusFilter = request.query.status;
      const items = await fastify.prisma.channelOpenItem.findMany({
        orderBy: { createdAt: 'desc' },
        where: {
          channelId: request.params.id,
          ...(statusFilter && statusFilter !== 'all' ? { status: statusFilter } : {}),
        },
      });
      return { data: items };
    }
  );

  // PATCH /:id/open-items/:itemId — update status (dismiss/resolve). ADMIN only.
  app.patch(
    '/:id/open-items/:itemId',
    { onRequest: adminOnly, schema: { body: OpenItemStatusSchema, params: OpenItemParams } },
    async (request, reply) => {
      const item = await fastify.prisma.channelOpenItem.findUnique({
        where: { id: request.params.itemId },
      });
      if (!item || item.channelId !== request.params.id) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Item not found' } });
      }
      const updated = await fastify.prisma.channelOpenItem.update({
        data: { status: request.body.status },
        where: { id: item.id },
      });
      return { data: updated };
    }
  );

  // GET /:id/audit — Gap J: per-channel "who asked what, when, what it touched"
  // audit feed. Aggregation over the lightweight channel `WorkflowRun` rows
  // (created by startChannelRun): each row carries `specSnapshot.channel`
  // metadata (kind/userSlackId/userText) plus the run's denormalized
  // status/cost/tokens. The `runId` links to the full `/runs/<id>` trace, which
  // shows the tool calls the turn actually made ("what it touched").
  const AuditQuery = z.object({
    kind: z.enum(['mention', 'ambient', 'reactive', 'all']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  });
  app.get(
    '/:id/audit',
    { onRequest: authed, schema: { params: IdParams, querystring: AuditQuery } },
    async (request, reply) => {
      const user = requireUser(request);
      const channel = await fastify.prisma.slackChannel.findUnique({
        select: { teamId: true },
        where: { id: request.params.id },
      });
      if (!channel) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Channel not found' } });
      }
      if (!(await assertChannelAccess(fastify, user, channel.teamId, reply))) {
        return reply;
      }

      // Match channel runs by the channelId stashed in the Json spec snapshot.
      // The kind filter is pushed into the WHERE clause (a second JSON-path
      // predicate on `channel.kind`) rather than applied in JS after `take`, so
      // `take`/`limit` caps the already-filtered set — a post-take JS filter would
      // silently under-return (cron ambient/reactive runs dominate the recent
      // window, starving a `kind=mention` request).
      const kindFilter = request.query.kind;
      const runs = await fastify.prisma.workflowRun.findMany({
        orderBy: { startedAt: 'desc' },
        select: {
          costUsdAccrued: true,
          endedAt: true,
          id: true,
          specSnapshot: true,
          startedAt: true,
          status: true,
          tokensInputTotal: true,
          tokensOutputTotal: true,
        },
        take: request.query.limit ?? 50,
        where: {
          AND: [
            { specSnapshot: { equals: request.params.id, path: ['channel', 'channelId'] } },
            ...(kindFilter && kindFilter !== 'all'
              ? [{ specSnapshot: { equals: kindFilter, path: ['channel', 'kind'] } }]
              : []),
          ],
        },
      });

      const data = runs.map((run) => {
        const meta =
          (run.specSnapshot as { channel?: Record<string, unknown> } | null)?.channel ?? {};
        return {
          costUsd: Number(run.costUsdAccrued ?? 0),
          createdAt: run.startedAt,
          endedAt: run.endedAt,
          kind: (meta.kind as string) ?? 'mention',
          runId: run.id,
          status: run.status,
          tokensInput: Number(run.tokensInputTotal ?? 0),
          tokensOutput: Number(run.tokensOutputTotal ?? 0),
          userSlackId: (meta.userSlackId as string | null) ?? null,
          userText: (meta.userText as string | null) ?? null,
        };
      });

      return { data };
    }
  );

  // DELETE /:id — remove the channel row (ADMIN only).
  app.delete(
    '/:id',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const current = await fastify.prisma.slackChannel.findUnique({
        where: { id: request.params.id },
      });
      if (!current) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Channel not found' } });
      }
      await fastify.prisma.slackChannel.delete({ where: { id: current.id } });
      // Best-effort schedule teardown — never block the delete on a Temporal
      // hiccup; an orphaned schedule fires a workflow that no-ops on a missing
      // channel and can be reaped out of band.
      try {
        await Promise.all([
          fastify.temporal.deleteChannelAmbientSchedule(current.id),
          fastify.temporal.deleteChannelReactiveSchedule(current.id),
        ]);
      } catch (err) {
        request.log.error(
          { channelId: current.id, err },
          'failed to delete channel ambient/reactive schedule'
        );
      }
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor,
        before: { slackChannelId: current.slackChannelId, teamId: current.teamId },
        entityId: current.id,
        entityType: 'SlackChannel',
      });
      return reply.send({ data: { deleted: true } });
    }
  );
};
