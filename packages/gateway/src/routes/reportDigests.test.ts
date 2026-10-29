import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import { reportDigestRoutes } from './reportDigests.js';

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
    organization: { findMany: vi.fn().mockResolvedValue([]) },
    organizationMembership: {
      findMany: vi.fn().mockResolvedValue((membership.orgIds ?? []).map((orgId) => ({ orgId }))),
    },
    reportDigestSubscription: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      delete: vi.fn().mockResolvedValue(undefined),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
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
  };
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('temporal', temporal as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
  } as unknown as never);
  await app.register(reportDigestRoutes, { prefix: '/api/v1/report-digests' });
  await app.ready();
  return { app, prisma, temporal };
}

describe('report digest routes', () => {
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

  it('rate-limits send-test to once per minute per subscription', async () => {
    const { app, prisma, temporal } = await buildApp('ADMIN');
    prisma.reportDigestSubscription.findUnique.mockResolvedValue({
      id: SUBSCRIPTION,
      orgId: ORG_A,
      scope: 'ORGANIZATION',
      teamId: null,
    });
    const url = `/api/v1/report-digests/${SUBSCRIPTION}/send-test`;
    const first = await app.inject({ headers: AUTH, method: 'POST', url });
    const second = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(429);
    expect(temporal.triggerReportDigestTest).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
