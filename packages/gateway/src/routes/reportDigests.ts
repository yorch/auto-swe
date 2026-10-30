import {
  reportDigestUnsubscribeSubscriptionId,
  verifyReportDigestUnsubscribeToken,
} from '@auto-swe/shared/lib/reportDigestUnsubscribe';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { registerFormBodyParser } from '../lib/formBody.js';
import { claimReportDigestTestSend } from '../lib/reportDigestRateLimit.js';
import { getErrorName, requireAuth, requireUser } from '../plugins/auth.js';

const paramsSchema = z.object({ id: z.string().uuid() });
const bodySchema = z
  .object({
    confirmOptedOutReadd: z.array(z.string().email()).max(20).optional(),
    emailRecipients: z.array(z.string().email()).max(20).optional(),
    enabled: z.boolean().optional(),
    orgId: z.string().uuid().nullable().optional(),
    scope: z.enum(['ORGANIZATION', 'TEAM']).optional(),
    slackChannelId: z.string().uuid().nullable().optional(),
    teamId: z.string().uuid().nullable().optional(),
  })
  .strict();
const createBodySchema = bodySchema.omit({ confirmOptedOutReadd: true });
const MAX_SUBSCRIPTIONS_PER_SCOPE = 5;
const unsubscribeQuerySchema = z.object({ token: z.string().min(1).max(256) });
const unsubscribeBodySchema = z.object({ 'List-Unsubscribe': z.literal('One-Click') }).strict();

function setUnsubscribeResponseHeaders(reply: FastifyReply): void {
  reply
    .header(
      'Content-Security-Policy',
      "default-src 'none'; form-action 'self'; frame-ancestors 'none'"
    )
    .header('X-Frame-Options', 'DENY')
    .header('Referrer-Policy', 'no-referrer')
    .header('Cache-Control', 'no-store')
    .header('X-Content-Type-Options', 'nosniff');
}

export const reportDigestRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = requireAuth({ requiredRole: 'ENGINEER' });

  try {
    registerFormBodyParser(fastify);
  } catch {
    // The gateway may already have installed the shared form parser.
  }

  const verifiedUnsubscribeRecipient = async (token: string) => {
    const subscriptionId = reportDigestUnsubscribeSubscriptionId(token);
    if (!subscriptionId) {
      return null;
    }
    const subscription = await runUnscoped(
      'the public digest unsubscribe validates only its signed subscription',
      ['ReportDigestSubscription'],
      () =>
        fastify.prisma.reportDigestSubscription.findUnique({
          select: { emailRecipients: true, id: true, optedOutEmails: true },
          where: { id: subscriptionId },
        })
    );
    if (!subscription) {
      return null;
    }
    let matchedEmail: string | null = null;
    for (const email of new Set([
      ...subscription.emailRecipients,
      ...subscription.optedOutEmails,
    ])) {
      if (verifyReportDigestUnsubscribeToken(token, subscription.id, email)) {
        matchedEmail = email.trim().toLowerCase();
      }
    }
    return matchedEmail ? { email: matchedEmail, subscription } : null;
  };

  app.get(
    '/unsubscribe',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { querystring: unsubscribeQuerySchema },
    },
    async (request, reply) => {
      setUnsubscribeResponseHeaders(reply);
      const { token } = request.query;
      if (!(await verifiedUnsubscribeRecipient(token))) {
        return reply.status(400).type('text/plain').send('Invalid unsubscribe link.');
      }
      const action = `/api/v1/report-digests/unsubscribe?token=${encodeURIComponent(token)}`;
      return reply
        .type('text/html; charset=utf-8')
        .send(
          `<!doctype html><html><body><p>Confirm you want to unsubscribe from this report digest.</p><form method="post" action="${action}"><button name="List-Unsubscribe" value="One-Click" type="submit">Unsubscribe</button></form></body></html>`
        );
    }
  );

  app.post(
    '/unsubscribe',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { body: unsubscribeBodySchema, querystring: unsubscribeQuerySchema },
    },
    async (request, reply) => {
      setUnsubscribeResponseHeaders(reply);
      const recipient = await verifiedUnsubscribeRecipient(request.query.token);
      if (!recipient) {
        return reply.status(400).type('text/plain').send('Invalid unsubscribe link.');
      }
      if (
        !recipient.subscription.optedOutEmails.some(
          (email) => email.trim().toLowerCase() === recipient.email
        )
      ) {
        await runUnscoped(
          'the public digest unsubscribe records only its verified recipient',
          ['ReportDigestSubscription'],
          () =>
            fastify.prisma.reportDigestSubscription.updateMany({
              data: { optedOutEmails: { push: recipient.email } },
              where: {
                id: recipient.subscription.id,
                NOT: { optedOutEmails: { has: recipient.email } },
              },
            })
        );
      }
      return reply
        .type('text/html; charset=utf-8')
        .send(
          '<!doctype html><html><body><p>You have been unsubscribed from this report digest.</p></body></html>'
        );
    }
  );

  const membershipScopes = async (userId: string) => {
    const [orgs, teams] = await runUnscoped(
      'digest scope authorization reads the caller memberships',
      ['OrganizationMembership', 'TeamMembership'],
      () =>
        Promise.all([
          fastify.prisma.organizationMembership.findMany({
            select: { orgId: true },
            where: { role: 'ORG_ADMIN', userId },
          }),
          fastify.prisma.teamMembership.findMany({
            select: { role: true, teamId: true },
            where: { role: { in: ['LEAD', 'ADMIN'] }, userId },
          }),
        ])
    );
    const orgTeamIds = orgs.length
      ? await runUnscoped('digest scope authorization resolves organization teams', ['Team'], () =>
          fastify.prisma.team.findMany({
            select: { id: true },
            where: { orgId: { in: orgs.map(({ orgId }) => orgId) } },
          })
        )
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
    const emailRecipients = [
      ...new Set(value.emailRecipients.map((email) => email.trim().toLowerCase())),
    ];
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
        select: { orgId: true, teamId: true },
        where: { id: value.slackChannelId },
      });
      if (channel && channel.orgId !== orgId) {
        return { error: 'Slack channel must belong to the same organization' };
      }
      if (channel && value.scope === 'TEAM' && channel.teamId !== value.teamId) {
        return { error: 'Slack channel must belong to the same team' };
      }
      if (!channel) {
        return { error: 'Slack channel not found' };
      }
    }
    if (emailRecipients.length) {
      const memberUsers = await fastify.prisma.user.findMany({
        select: { email: true },
        where: {
          email: { in: emailRecipients },
          isActive: true,
          ...(value.scope === 'ORGANIZATION'
            ? { orgMemberships: { some: { orgId: value.orgId as string } } }
            : { memberships: { some: { teamId: value.teamId as string } } }),
        },
      });
      const memberEmails = new Set(memberUsers.map(({ email }) => email.toLowerCase()));
      const offendingAddresses = value.emailRecipients.filter(
        (email) => !memberEmails.has(email.trim().toLowerCase())
      );
      if (offendingAddresses.length) {
        return {
          error: 'Recipients must be active users who belong to the subscription scope',
          offendingAddresses,
        };
      }
    }
    return { emailRecipients, orgId };
  };

  const countScopeSubscriptions = (
    value: { orgId: string | null; scope: 'ORGANIZATION' | 'TEAM'; teamId: string | null },
    excludingId?: string
  ) =>
    runUnscoped(
      'digest scope authorization counts subscriptions',
      ['ReportDigestSubscription'],
      () =>
        fastify.prisma.reportDigestSubscription.count({
          where: {
            ...(excludingId ? { id: { not: excludingId } } : {}),
            orgId: value.orgId,
            scope: value.scope,
            teamId: value.teamId,
          },
        })
    );

  app.get('/', { onRequest: auth }, async (request) => {
    const user = requireUser(request);
    const scopes = await membershipScopes(user.sub);
    const OR = [
      ...(scopes.orgIds.length ? [{ orgId: { in: scopes.orgIds } }] : []),
      ...(scopes.teamIds.length ? [{ teamId: { in: scopes.teamIds } }] : []),
    ];
    const [subscriptions, organizations, teams, channels] = await Promise.all([
      runUnscoped(
        'authorized users list report digest subscriptions',
        ['ReportDigestSubscription'],
        () =>
          fastify.prisma.reportDigestSubscription.findMany({
            include: { organization: true, slackChannel: true, team: true },
            orderBy: { createdAt: 'desc' },
            where: user.role === 'ADMIN' ? undefined : { OR },
          })
      ),
      fastify.prisma.organization.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
        where: user.role === 'ADMIN' ? undefined : { id: { in: scopes.orgIds } },
      }),
      runUnscoped('authorized users list manageable digest teams', ['Team'], () =>
        fastify.prisma.team.findMany({
          orderBy: { name: 'asc' },
          select: { id: true, name: true, orgId: true },
          where: user.role === 'ADMIN' ? undefined : { id: { in: scopes.teamIds } },
        })
      ),
      runUnscoped('authorized users list manageable digest channels', ['SlackChannel'], () =>
        fastify.prisma.slackChannel.findMany({
          orderBy: { name: 'asc' },
          select: { id: true, name: true, orgId: true, teamId: true },
          where:
            user.role === 'ADMIN'
              ? undefined
              : {
                  OR: [{ orgId: { in: scopes.orgIds } }, { teamId: { in: scopes.teamIds } }],
                },
        })
      ),
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

  app.post('/', { onRequest: auth, schema: { body: createBodySchema } }, async (request, reply) => {
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
      return reply.status(400).send({
        error: checked.error,
        ...('offendingAddresses' in checked
          ? { offendingAddresses: checked.offendingAddresses }
          : {}),
      });
    }
    const candidate = { orgId, scope: body.scope, teamId };
    if (!(await canManage(user, candidate))) {
      return reply.status(403).send({ error: 'Digest scope access is not authorized' });
    }
    if ((await countScopeSubscriptions(candidate)) >= MAX_SUBSCRIPTIONS_PER_SCOPE) {
      return reply.status(409).send({ error: 'A scope can have at most 5 digest subscriptions' });
    }
    return reply.status(201).send({
      data: await fastify.prisma.reportDigestSubscription.create({
        data: {
          createdById: user.sub,
          emailRecipients: checked.emailRecipients,
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
        return reply.status(400).send({
          error: checked.error,
          ...('offendingAddresses' in checked
            ? { offendingAddresses: checked.offendingAddresses }
            : {}),
        });
      }
      if (!(await canManage(user, value))) {
        return reply.status(403).send({ error: 'Digest scope access is not authorized' });
      }
      if (
        (await countScopeSubscriptions(
          value as {
            orgId: string | null;
            scope: 'ORGANIZATION' | 'TEAM';
            teamId: string | null;
          },
          existing.id
        )) >= MAX_SUBSCRIPTIONS_PER_SCOPE
      ) {
        return reply.status(409).send({ error: 'A scope can have at most 5 digest subscriptions' });
      }
      const optedOut = new Set(existing.optedOutEmails.map((email) => email.trim().toLowerCase()));
      const existingRecipients = new Set(
        existing.emailRecipients.map((email) => email.trim().toLowerCase())
      );
      const requestedRecipients = new Set(
        checked.emailRecipients.map((email) => email.trim().toLowerCase())
      );
      const { confirmOptedOutReadd, ...patchBody } = request.body;
      const confirmations = new Set(
        (confirmOptedOutReadd ?? []).map((email) => email.trim().toLowerCase())
      );
      const readdedRecipients = [...confirmations].filter(
        (email) => optedOut.has(email) && requestedRecipients.has(email)
      );
      const readded = new Set(readdedRecipients);
      const newlyAddedOptedOutRecipients = checked.emailRecipients
        .map((email) => email.trim().toLowerCase())
        .filter((email) => optedOut.has(email) && !existingRecipients.has(email));
      const invalidConfirmations = [...confirmations].filter(
        (email) => !optedOut.has(email) || !requestedRecipients.has(email)
      );
      const unconfirmedRecipients = newlyAddedOptedOutRecipients.filter(
        (email) => !confirmations.has(email)
      );
      if (unconfirmedRecipients.length > 0 || invalidConfirmations.length > 0) {
        return reply.status(400).send({
          error: 'Confirm each opted-out address before re-adding it',
          optedOutAddresses: [...unconfirmedRecipients, ...invalidConfirmations],
        });
      }
      const updated = await fastify.prisma.$transaction(async (tx) => {
        const result = await tx.reportDigestSubscription.update({
          data: {
            ...patchBody,
            ...(request.body.emailRecipients !== undefined || readdedRecipients.length > 0
              ? {
                  optedOutEmails: {
                    set: existing.optedOutEmails.filter(
                      (email) => !readded.has(email.trim().toLowerCase())
                    ),
                  },
                }
              : {}),
            emailRecipients: checked.emailRecipients,
            orgId: value.orgId,
            scope: value.scope,
            teamId: value.teamId,
          },
          where: { id: existing.id },
        });
        if (readdedRecipients.length > 0) {
          await writeAuditLog(fastify, {
            action: 'UPDATE',
            actor: user,
            after: { readdedRecipients },
            before: { optedOutRecipients: readdedRecipients },
            client: tx,
            entityId: existing.id,
            entityType: 'ReportDigestSubscription',
          });
        }
        return result;
      });
      return { data: updated };
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
      const now = new Date();
      if (!(await claimReportDigestTestSend(fastify.prisma, existing.id, now))) {
        return reply.status(429).send({ error: 'Send-test is limited to once per minute' });
      }
      try {
        await fastify.temporal.triggerReportDigestTest(existing.id);
      } catch (err) {
        if (getErrorName(err) === 'WorkflowExecutionAlreadyStartedError') {
          return reply
            .status(409)
            .send({ error: 'A test digest is already running for this subscription' });
        }
        throw err;
      }
      return reply.status(202).send({ data: { accepted: true } });
    }
  );
};
