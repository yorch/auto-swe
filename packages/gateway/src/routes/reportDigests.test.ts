import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import { reportDigestRoutes } from './reportDigests.js';

vi.mock('@auto-swe/shared/lib/reportDigestUnsubscribe', () => ({
  reportDigestUnsubscribeSubscriptionId: (token: string) =>
    token === 'valid-token' ? '66666666-6666-4666-8666-666666666666' : null,
  verifyReportDigestUnsubscribeToken: (token: string, id: string, email: string) =>
    token === 'valid-token' &&
    id === '66666666-6666-4666-8666-666666666666' &&
    email.toLowerCase() === 'digest@example.test',
}));

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const TEAM_A = '33333333-3333-4333-8333-333333333333';
const TEAM_B = '44444444-4444-4444-8444-444444444444';
const CHANNEL_B = '55555555-5555-4555-8555-555555555555';
const SUBSCRIPTION = '66666666-6666-4666-8666-666666666666';
const AUTH = { authorization: 'Bearer fake' };

async function buildApp(role: string, membership: { orgIds?: string[]; teamIds?: string[] } = {}) {
  const temporal = { triggerReportDigestTest: vi.fn().mockResolvedValue(undefined) };
  const prisma = {
    configAuditLog: { create: vi.fn().mockResolvedValue(undefined) },
    organization: { findMany: vi.fn().mockResolvedValue([]) },
    organizationMembership: {
      findMany: vi.fn().mockResolvedValue((membership.orgIds ?? []).map((orgId) => ({ orgId }))),
    },
    reportDigestSubscription: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      delete: vi.fn().mockResolvedValue(undefined),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    slackChannel: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue({ orgId: ORG_B }),
    },
    team: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        orgId: where.id === TEAM_A ? ORG_A : ORG_B,
      })),
    },
    teamMembership: {
      findMany: vi
        .fn()
        .mockResolvedValue((membership.teamIds ?? []).map((teamId) => ({ role: 'LEAD', teamId }))),
    },
    user: {
      findMany: vi.fn(async ({ where }: { where: { email: { in: string[] } } }) =>
        where.email.in.map((email) => ({ email }))
      ),
    },
  };
  const database = Object.assign(prisma, {
    $transaction: (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma),
  });
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('prisma', database as unknown as never);
  app.decorate('temporal', temporal as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
  } as unknown as never);
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' });
  await app.register(reportDigestRoutes, { prefix: '/api/v1/report-digests' });
  await app.ready();
  return { app, prisma, temporal };
}

describe('report digest routes', () => {
  it('renders a non-mutating confirmation on GET and opts out through the RFC 8058 POST', async () => {
    const { app, prisma } = await buildApp('VIEWER');
    prisma.reportDigestSubscription.findUnique.mockResolvedValue({
      emailRecipients: ['digest@example.test'],
      id: SUBSCRIPTION,
      optedOutEmails: [],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/report-digests/unsubscribe?token=valid-token',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('method="post"');
    expect(response.body).toContain('List-Unsubscribe');
    expect(response.body).toContain(
      'action="/api/v1/report-digests/unsubscribe?token=valid-token"'
    );
    expect(prisma.reportDigestSubscription.updateMany).not.toHaveBeenCalled();

    const post = await app.inject({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
      payload: 'List-Unsubscribe=One-Click',
      url: '/api/v1/report-digests/unsubscribe?token=valid-token',
    });

    expect(post.statusCode).toBe(200);
    expect(post.body).toContain('You have been unsubscribed');
    expect(prisma.reportDigestSubscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { optedOutEmails: { push: 'digest@example.test' } },
        where: expect.objectContaining({ id: SUBSCRIPTION }),
      })
    );
    await app.close();
  });

  it('rate limits the public unsubscribe confirmation route', async () => {
    const { app } = await buildApp('VIEWER');
    const responses = await Promise.all(
      Array.from({ length: 31 }, () =>
        app.inject({
          method: 'GET',
          url: '/api/v1/report-digests/unsubscribe?token=invalid-token',
        })
      )
    );

    expect(responses.at(-1)?.statusCode).toBe(429);
    await app.close();

    const postApp = await buildApp('VIEWER');
    const postResponses = await Promise.all(
      Array.from({ length: 31 }, () =>
        postApp.app.inject({
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          method: 'POST',
          payload: 'List-Unsubscribe=One-Click',
          url: '/api/v1/report-digests/unsubscribe?token=invalid-token',
        })
      )
    );

    expect(postResponses.at(-1)?.statusCode).toBe(429);
    await postApp.app.close();
  });

  it('requires confirmation and audits a manager re-adding an opted-out recipient', async () => {
    const { app, prisma } = await buildApp('ADMIN');
    prisma.reportDigestSubscription.findUnique.mockResolvedValue({
      emailRecipients: [],
      id: SUBSCRIPTION,
      optedOutEmails: ['digest@example.test'],
      orgId: ORG_A,
      scope: 'ORGANIZATION',
      slackChannelId: null,
      teamId: null,
    });

    const unconfirmed = await app.inject({
      headers: AUTH,
      method: 'PATCH',
      payload: { emailRecipients: ['digest@example.test'] },
      url: `/api/v1/report-digests/${SUBSCRIPTION}`,
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(prisma.reportDigestSubscription.update).not.toHaveBeenCalled();

    const response = await app.inject({
      headers: AUTH,
      method: 'PATCH',
      payload: {
        confirmOptedOutReadd: ['digest@example.test'],
        emailRecipients: ['digest@example.test'],
      },
      url: `/api/v1/report-digests/${SUBSCRIPTION}`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(prisma.reportDigestSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          emailRecipients: ['digest@example.test'],
          optedOutEmails: { set: [] },
        }),
      })
    );
    expect(prisma.configAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'UPDATE',
          actorId: 'user-1',
          entityId: SUBSCRIPTION,
          entityType: 'ReportDigestSubscription',
        }),
      })
    );
    await app.close();
  });

  it('allows an org admin to create an org digest only for their own organization', async () => {
    const { app, prisma } = await buildApp('ENGINEER', { orgIds: [ORG_A] });
    const own = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { emailRecipients: ['reports@example.test'], orgId: ORG_A, scope: 'ORGANIZATION' },
      url: '/api/v1/report-digests',
    });
    expect(own.statusCode).toBe(201);
    expect(prisma.reportDigestSubscription.create).toHaveBeenCalled();
    const other = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { emailRecipients: ['reports@example.test'], orgId: ORG_B, scope: 'ORGANIZATION' },
      url: '/api/v1/report-digests',
    });
    expect(other.statusCode).toBe(403);
    await app.close();
  });

  it('allows team members to manage their team but denies a lead from another team', async () => {
    const { app } = await buildApp('LEAD', { teamIds: [TEAM_A] });
    const body = (teamId: string) => ({
      emailRecipients: ['reports@example.test'],
      scope: 'TEAM',
      teamId,
    });
    const own = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: body(TEAM_A),
      url: '/api/v1/report-digests',
    });
    expect(own.statusCode).toBe(201);
    const other = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: body(TEAM_B),
      url: '/api/v1/report-digests',
    });
    expect(other.statusCode).toBe(403);
    await app.close();
  });

  it('rejects Slack channels from another organization', async () => {
    const { app } = await buildApp('ENGINEER', { orgIds: [ORG_A] });
    const response = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: {
        orgId: ORG_A,
        scope: 'ORGANIZATION',
        slackChannelId: CHANNEL_B,
      },
      url: '/api/v1/report-digests',
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a TEAM digest with another team’s Slack channel', async () => {
    const { app, prisma } = await buildApp('LEAD', { teamIds: [TEAM_A] });
    prisma.slackChannel.findUnique.mockResolvedValue({ orgId: ORG_A, teamId: TEAM_B });
    const response = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { scope: 'TEAM', slackChannelId: CHANNEL_B, teamId: TEAM_A },
      url: '/api/v1/report-digests',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('same team');
    await app.close();
  });

  it('rejects recipients who are not active members of the scope', async () => {
    const { app, prisma } = await buildApp('ENGINEER', { orgIds: [ORG_A] });
    prisma.user.findMany.mockResolvedValue([]);
    const response = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: {
        emailRecipients: ['outsider@example.test'],
        orgId: ORG_A,
        scope: 'ORGANIZATION',
      },
      url: '/api/v1/report-digests',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().offendingAddresses).toEqual(['outsider@example.test']);
    await app.close();
  });

  it('rejects a sixth subscription in one scope', async () => {
    const { app, prisma } = await buildApp('ENGINEER', { orgIds: [ORG_A] });
    prisma.reportDigestSubscription.count.mockResolvedValue(5);
    const response = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: {
        emailRecipients: ['reports@example.test'],
        orgId: ORG_A,
        scope: 'ORGANIZATION',
      },
      url: '/api/v1/report-digests',
    });
    expect(response.statusCode).toBe(409);
    await app.close();
  });

  it('forbids moving a subscription to a team the caller does not lead', async () => {
    const { app, prisma } = await buildApp('LEAD', { teamIds: [TEAM_A] });
    prisma.reportDigestSubscription.findUnique.mockResolvedValue({
      emailRecipients: ['reports@example.test'],
      id: SUBSCRIPTION,
      orgId: null,
      scope: 'TEAM',
      slackChannelId: null,
      teamId: TEAM_A,
    });
    const response = await app.inject({
      headers: AUTH,
      method: 'PATCH',
      payload: { teamId: TEAM_B },
      url: `/api/v1/report-digests/${SUBSCRIPTION}`,
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('rate-limits send-test to once per minute per subscription', async () => {
    const { app, prisma, temporal } = await buildApp('ADMIN');
    prisma.reportDigestSubscription.findUnique.mockResolvedValue({
      id: SUBSCRIPTION,
      orgId: ORG_A,
      scope: 'ORGANIZATION',
      teamId: null,
    });
    prisma.reportDigestSubscription.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const url = `/api/v1/report-digests/${SUBSCRIPTION}/send-test`;
    const first = await app.inject({ headers: AUTH, method: 'POST', url });
    const second = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(429);
    expect(temporal.triggerReportDigestTest).toHaveBeenCalledTimes(1);
    expect(prisma.reportDigestSubscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastTestSentAt: expect.any(Date) }),
        where: expect.objectContaining({
          id: SUBSCRIPTION,
          OR: expect.arrayContaining([expect.objectContaining({ lastTestSentAt: null })]),
        }),
      })
    );
    await app.close();
  });
});
