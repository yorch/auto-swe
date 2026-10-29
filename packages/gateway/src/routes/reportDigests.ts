import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requireUser } from '../plugins/auth.js';

const paramsSchema = z.object({ id: z.string().uuid() });
const bodySchema = z
  .object({
    emailRecipients: z.array(z.string().email()).max(20).optional(),
    enabled: z.boolean().optional(),
    orgId: z.string().uuid().nullable().optional(),
    scope: z.enum(['ORGANIZATION', 'TEAM']).optional(),
    slackChannelId: z.string().uuid().nullable().optional(),
    teamId: z.string().uuid().nullable().optional(),
  })
  .strict();
const sendTestAt = new Map<string, number>();

export const reportDigestRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = requireAuth({ requiredRole: 'ENGINEER' });

  const membershipScopes = async (userId: string) => {
    const [orgs, teams] = await Promise.all([
      fastify.prisma.organizationMembership.findMany({
        select: { orgId: true },
        where: { role: 'ORG_ADMIN', userId },
      }),
      fastify.prisma.teamMembership.findMany({
        select: { role: true, teamId: true },
        where: { role: { in: ['LEAD', 'ADMIN'] }, userId },
      }),
    ]);
    const orgTeamIds = orgs.length
      ? await fastify.prisma.team.findMany({
          select: { id: true },
          where: { orgId: { in: orgs.map(({ orgId }) => orgId) } },
        })
      : [];
    return {
      orgIds: orgs.map(({ orgId }) => orgId),
      teamIds: [
        ...new Set([...teams.map(({ teamId }) => teamId), ...orgTeamIds.map(({ id }) => id)]),
      ],
    };
  };

  const canManage = async (
    user: { role: string; sub: string },
    subscription: { orgId: string | null; scope: string; teamId: string | null }
  ) => {
    if (user.role === 'ADMIN') {
      return true;
    }
    const scopes = await membershipScopes(user.sub);
    if (subscription.scope === 'ORGANIZATION') {
      return !!subscription.orgId && scopes.orgIds.includes(subscription.orgId);
    }
    if (subscription.teamId && scopes.teamIds.includes(subscription.teamId)) {
      return true;
    }
    if (!subscription.teamId || !scopes.orgIds.length) {
      return false;
    }
    const team = await fastify.prisma.team.findUnique({
      select: { orgId: true },
      where: { id: subscription.teamId },
    });
    return !!team?.orgId && scopes.orgIds.includes(team.orgId);
  };

  const validateSubscription = async (value: {
    emailRecipients: string[];
    orgId: string | null;
    scope: 'ORGANIZATION' | 'TEAM';
    slackChannelId: string | null;
    teamId: string | null;
  }) => {
    if ((value.scope === 'ORGANIZATION') !== !!value.orgId || !!value.orgId === !!value.teamId) {
      return { error: 'Exactly one matching organization or team scope is required' };
    }
    if (!value.emailRecipients.length && !value.slackChannelId) {
      return { error: 'At least one email recipient or Slack channel is required' };
    }
    let orgId = value.orgId;
    if (value.scope === 'TEAM' && value.teamId) {
      const team = await fastify.prisma.team.findUnique({
        select: { orgId: true },
        where: { id: value.teamId },
      });
      if (!team) {
        return { error: 'Team not found' };
      }
      orgId = team.orgId;
    }
    if (value.slackChannelId) {
      const channel = await fastify.prisma.slackChannel.findUnique({
        select: { orgId: true },
        where: { id: value.slackChannelId },
      });
      if (channel && channel.orgId !== orgId) {
        return { error: 'Slack channel must belong to the same organization' };
      }
      if (!channel) {
        return { error: 'Slack channel not found' };
      }
    }
    return { orgId };
  };

  app.get('/', { onRequest: auth }, async (request) => {
    const user = requireUser(request);
    const scopes = await membershipScopes(user.sub);
    const OR = [
      ...(scopes.orgIds.length ? [{ orgId: { in: scopes.orgIds } }] : []),
      ...(scopes.teamIds.length ? [{ teamId: { in: scopes.teamIds } }] : []),
    ];
    const [subscriptions, organizations, teams, channels] = await Promise.all([
      fastify.prisma.reportDigestSubscription.findMany({
        include: { organization: true, slackChannel: true, team: true },
        orderBy: { createdAt: 'desc' },
        where: user.role === 'ADMIN' ? undefined : { OR },
      }),
      fastify.prisma.organization.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
        where: user.role === 'ADMIN' ? undefined : { id: { in: scopes.orgIds } },
      }),
      fastify.prisma.team.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, orgId: true },
        where: user.role === 'ADMIN' ? undefined : { id: { in: scopes.teamIds } },
      }),
      fastify.prisma.slackChannel.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, orgId: true, teamId: true },
        where:
          user.role === 'ADMIN'
            ? undefined
            : {
                OR: [{ orgId: { in: scopes.orgIds } }, { teamId: { in: scopes.teamIds } }],
              },
      }),
    ]);
    return {
      data: {
        channels,
        organizations,
        subscriptions: OR.length || user.role === 'ADMIN' ? subscriptions : [],
        teams,
      },
    };
  });

  app.post('/', { onRequest: auth, schema: { body: bodySchema } }, async (request, reply) => {
    const user = requireUser(request);
    const body = request.body;
    if (!body.scope) {
      return reply.status(400).send({ error: 'Scope and its identifier are required' });
    }
    const emailRecipients = body.emailRecipients ?? [];
    const orgId = body.orgId ?? null;
    const teamId = body.teamId ?? null;
    const slackChannelId = body.slackChannelId ?? null;
    const checked = await validateSubscription({
      emailRecipients,
      orgId,
      scope: body.scope,
      slackChannelId,
      teamId,
    });
    if ('error' in checked) {
      return reply.status(400).send({ error: checked.error });
    }
    const candidate = { orgId, scope: body.scope, teamId };
    if (!(await canManage(user, candidate))) {
      return reply.status(403).send({ error: 'Digest scope access is not authorized' });
    }
    return reply.status(201).send({
      data: await fastify.prisma.reportDigestSubscription.create({
        data: {
          createdById: user.sub,
          emailRecipients,
          enabled: body.enabled ?? true,
          orgId,
          scope: body.scope,
          slackChannelId,
          teamId,
        },
      }),
    });
  });

  app.patch(
    '/:id',
    { onRequest: auth, schema: { body: bodySchema, params: paramsSchema } },
    async (request, reply) => {
      const user = requireUser(request);
      const existing = await fastify.prisma.reportDigestSubscription.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply.status(404).send({ error: 'Digest subscription not found' });
      }
      if (!(await canManage(user, existing))) {
        return reply.status(403).send({ error: 'Digest scope access is not authorized' });
      }
      const value = {
        emailRecipients: request.body.emailRecipients ?? existing.emailRecipients,
        orgId: request.body.orgId === undefined ? existing.orgId : request.body.orgId,
        scope: request.body.scope ?? existing.scope,
        slackChannelId:
          request.body.slackChannelId === undefined
            ? existing.slackChannelId
            : request.body.slackChannelId,
        teamId: request.body.teamId === undefined ? existing.teamId : request.body.teamId,
      } as const;
      const checked = await validateSubscription(value);
      if ('error' in checked) {
        return reply.status(400).send({ error: checked.error });
      }
      if (!(await canManage(user, value))) {
        return reply.status(403).send({ error: 'Digest scope access is not authorized' });
      }
      return {
        data: await fastify.prisma.reportDigestSubscription.update({
          data: {
            ...request.body,
            orgId: value.orgId,
            scope: value.scope,
            teamId: value.teamId,
          },
          where: { id: existing.id },
        }),
      };
    }
  );

  app.delete(
    '/:id',
    { onRequest: auth, schema: { params: paramsSchema } },
    async (request, reply) => {
      const user = requireUser(request);
      const existing = await fastify.prisma.reportDigestSubscription.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply.status(404).send({ error: 'Digest subscription not found' });
      }
      if (!(await canManage(user, existing))) {
        return reply.status(403).send({ error: 'Digest scope access is not authorized' });
      }
      await fastify.prisma.reportDigestSubscription.delete({ where: { id: existing.id } });
      return reply.status(204).send();
    }
  );

  app.post(
    '/:id/send-test',
    { onRequest: auth, schema: { params: paramsSchema } },
    async (request, reply) => {
      const user = requireUser(request);
      const existing = await fastify.prisma.reportDigestSubscription.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply.status(404).send({ error: 'Digest subscription not found' });
      }
      if (!(await canManage(user, existing))) {
        return reply.status(403).send({ error: 'Digest scope access is not authorized' });
      }
      const now = Date.now();
      if (now - (sendTestAt.get(existing.id) ?? 0) < 60_000) {
        return reply.status(429).send({ error: 'Send-test is limited to once per minute' });
      }
      sendTestAt.set(existing.id, now);
      await fastify.temporal.triggerReportDigestTest(existing.id);
      return reply.status(202).send({ data: { accepted: true } });
    }
  );
};
