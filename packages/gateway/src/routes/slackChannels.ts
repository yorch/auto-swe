import type { Prisma } from '@auto-swe/shared';
import { currentYearMonth } from '@auto-swe/shared/lib/billing';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { requireAuth, requireUser } from '../plugins/auth.js';
import { CRON_5_FIELD_RE } from './scheduledWorkRequests.js';

/**
 * SlackChannel admin management (Claude Tag, Phase 1). Phase 0 auto-provisions a
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

const CreateChannelSchema = z.object({
  agentKey: z.string().min(1).max(100).optional(),
  ambientCron: z.string().regex(CRON_5_FIELD_RE, CRON_MESSAGE).nullable().optional(),
  ambientEnabled: z.boolean().optional(),
  monthlyBudgetUsdCents: z.number().int().min(0).nullable().optional(),
  name: z.string().min(1).max(200).nullable().optional(),
  slackChannelId: z.string().min(1).max(50),
  slackTeamId: z.string().min(1).max(50),
  teamId: z.string().uuid(),
});

const UpdateChannelSchema = z.object({
  agentKey: z.string().min(1).max(100).optional(),
  ambientCron: z.string().regex(CRON_5_FIELD_RE, CRON_MESSAGE).nullable().optional(),
  ambientEnabled: z.boolean().optional(),
  isActive: z.boolean().optional(),
  monthlyBudgetUsdCents: z.number().int().min(0).nullable().optional(),
  name: z.string().min(1).max(200).nullable().optional(),
  teamId: z.string().uuid().optional(),
});

const channelInclude = {
  workspace: { select: { id: true, name: true, orgId: true, slackTeamId: true } },
} as const;

type ChannelRow = Prisma.SlackChannelGetPayload<{ include: typeof channelInclude }>;

/** Attach this month's ChannelMonthlyUsage row (or null) to a serialized channel. */
async function withCurrentUsage(fastify: FastifyInstance, row: ChannelRow) {
  const usage = await fastify.prisma.channelMonthlyUsage.findUnique({
    where: { channelId_yearMonth: { channelId: row.id, yearMonth: currentYearMonth() } },
  });
  return {
    ...row,
    currentMonthUsage: usage
      ? {
          costUsdAccrued: Number(usage.costUsdAccrued),
          runsCompleted: usage.runsCompleted,
          yearMonth: usage.yearMonth,
        }
      : null,
  };
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
    const rows = await fastify.prisma.slackChannel.findMany({
      include: channelInclude,
      orderBy: { createdAt: 'desc' },
      where,
    });
    const data = await Promise.all(rows.map((row) => withCurrentUsage(fastify, row)));
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
    if (user.role !== 'ADMIN') {
      const member = await fastify.prisma.teamMembership.findUnique({
        where: { userId_teamId: { teamId: row.teamId, userId: user.sub } },
      });
      if (!member) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Channel not found' } });
      }
    }
    return { data: await withCurrentUsage(fastify, row) };
  });

  // GET /:id/budget — current-month usage + the cap.
  app.get(
    '/:id/budget',
    { onRequest: authed, schema: { params: IdParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const row = await fastify.prisma.slackChannel.findUnique({
        select: { id: true, monthlyBudgetUsdCents: true, name: true, teamId: true },
        where: { id: request.params.id },
      });
      if (!row) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Channel not found' } });
      }
      if (user.role !== 'ADMIN') {
        const member = await fastify.prisma.teamMembership.findUnique({
          where: { userId_teamId: { teamId: row.teamId, userId: user.sub } },
        });
        if (!member) {
          return reply
            .status(404)
            .send({ error: { code: 'NOT_FOUND', message: 'Channel not found' } });
        }
      }
      const usage = await fastify.prisma.channelMonthlyUsage.findUnique({
        where: { channelId_yearMonth: { channelId: row.id, yearMonth: currentYearMonth() } },
      });
      return {
        channelId: row.id,
        channelName: row.name,
        currentMonthUsage: usage
          ? {
              costUsdAccrued: Number(usage.costUsdAccrued),
              runsCompleted: usage.runsCompleted,
              yearMonth: usage.yearMonth,
            }
          : null,
        monthlyBudgetUsdCents: row.monthlyBudgetUsdCents,
      };
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

      // Upsert the workspace (org from the team), then create the channel.
      const workspace = await fastify.prisma.slackWorkspace.upsert({
        create: { orgId: team.orgId, slackTeamId: body.slackTeamId },
        update: {},
        where: { slackTeamId: body.slackTeamId },
      });

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
          ...(body.agentKey !== undefined ? { agentKey: body.agentKey } : {}),
          ...(body.ambientCron !== undefined ? { ambientCron: body.ambientCron } : {}),
          ...(body.ambientEnabled !== undefined ? { ambientEnabled: body.ambientEnabled } : {}),
          ...(body.monthlyBudgetUsdCents !== undefined
            ? { monthlyBudgetUsdCents: body.monthlyBudgetUsdCents }
            : {}),
          ...(body.name !== undefined ? { name: body.name } : {}),
          orgId: team.orgId,
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
          ...(body.agentKey !== undefined ? { agentKey: body.agentKey } : {}),
          ...(body.ambientCron !== undefined ? { ambientCron: body.ambientCron } : {}),
          ...(body.ambientEnabled !== undefined ? { ambientEnabled: body.ambientEnabled } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          ...(body.monthlyBudgetUsdCents !== undefined
            ? { monthlyBudgetUsdCents: body.monthlyBudgetUsdCents }
            : {}),
          ...(body.name !== undefined ? { name: body.name } : {}),
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

      return reply.send({ data: await withCurrentUsage(fastify, row) });
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
