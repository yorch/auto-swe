import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { slackChannelRoutes } from './slackChannels.js';

function newMockPrisma() {
  return {
    channelMonthlyUsage: { findUnique: vi.fn().mockResolvedValue(null) },
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    slackChannel: {
      create: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    slackWorkspace: { upsert: vi.fn() },
    team: { findUnique: vi.fn() },
    teamMembership: { findUnique: vi.fn() },
  };
}

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const mockPrisma = newMockPrisma();
  app.decorate('prisma', mockPrisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
  } as unknown as never);
  await app.register(slackChannelRoutes, { prefix: '/api/v1/admin/slack-channels' });
  await app.ready();
  return { app, mockPrisma };
}

const AUTH = { authorization: 'Bearer fake' };
const TEAM = '11111111-1111-4111-8111-111111111111';
const CHANNEL = '22222222-2222-4222-8222-222222222222';

beforeEach(() => vi.clearAllMocks());

describe('slackChannelRoutes', () => {
  it('lists channels with workspace + current-month usage (admin)', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.slackChannel.findMany.mockResolvedValue([
      { id: CHANNEL, name: 'general', teamId: TEAM, workspace: { id: 'ws-1' } },
    ]);
    mockPrisma.channelMonthlyUsage.findUnique.mockResolvedValue({
      costUsdAccrued: '1.5',
      runsCompleted: 3,
      yearMonth: '2026-06',
    });
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/admin/slack-channels',
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.payload).data;
    expect(data[0].id).toBe(CHANNEL);
    expect(data[0].currentMonthUsage.costUsdAccrued).toBe(1.5);
    await app.close();
  });

  it('non-admins are filtered to their teams', async () => {
    const { app, mockPrisma } = await buildApp('ENGINEER');
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/admin/slack-channels',
    });
    expect(res.statusCode).toBe(200);
    expect(mockPrisma.slackChannel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { team: { memberships: { some: { userId: 'user-1' } } } },
      })
    );
    await app.close();
  });

  it('gets one channel with usage', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.slackChannel.findUnique.mockResolvedValue({
      id: CHANNEL,
      name: 'general',
      teamId: TEAM,
      workspace: { id: 'ws-1' },
    });
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/admin/slack-channels/${CHANNEL}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.id).toBe(CHANNEL);
    await app.close();
  });

  it('creates a channel: upserts workspace, creates row, audits', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM, orgId: 'org-1' });
    mockPrisma.slackWorkspace.upsert.mockResolvedValue({ id: 'ws-1', orgId: 'org-1' });
    mockPrisma.slackChannel.findUnique.mockResolvedValue(null); // no duplicate
    mockPrisma.slackChannel.create.mockResolvedValue({
      id: CHANNEL,
      name: 'general',
      slackChannelId: 'C123',
      teamId: TEAM,
      workspace: { id: 'ws-1' },
    });
    const res = await app.inject({
      body: { name: 'general', slackChannelId: 'C123', slackTeamId: 'T123', teamId: TEAM },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/admin/slack-channels',
    });
    expect(res.statusCode).toBe(201);
    expect(mockPrisma.slackWorkspace.upsert).toHaveBeenCalled();
    expect(mockPrisma.slackChannel.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ orgId: 'org-1', teamId: TEAM }) })
    );
    expect(mockPrisma.configAuditLog.create).toHaveBeenCalled();
    await app.close();
  });

  it('400s when the team is missing on create', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.team.findUnique.mockResolvedValue(null);
    const res = await app.inject({
      body: { slackChannelId: 'C123', slackTeamId: 'T123', teamId: TEAM },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/admin/slack-channels',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('409s on a duplicate (workspace, channel) create', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM, orgId: 'org-1' });
    mockPrisma.slackWorkspace.upsert.mockResolvedValue({ id: 'ws-1', orgId: 'org-1' });
    mockPrisma.slackChannel.findUnique.mockResolvedValue({ id: CHANNEL });
    const res = await app.inject({
      body: { slackChannelId: 'C123', slackTeamId: 'T123', teamId: TEAM },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/admin/slack-channels',
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('rejects an invalid ambientCron on create', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      body: {
        ambientCron: 'not a cron',
        slackChannelId: 'C123',
        slackTeamId: 'T123',
        teamId: TEAM,
      },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/admin/slack-channels',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('patches mutable fields', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.slackChannel.findUnique.mockResolvedValue({
      agentKey: 'channelAssistant',
      id: CHANNEL,
      isActive: true,
      orgId: 'org-1',
      teamId: TEAM,
    });
    mockPrisma.slackChannel.update.mockResolvedValue({
      agentKey: 'customAgent',
      id: CHANNEL,
      isActive: false,
      teamId: TEAM,
      workspace: { id: 'ws-1' },
    });
    const res = await app.inject({
      body: { agentKey: 'customAgent', isActive: false },
      headers: AUTH,
      method: 'PATCH',
      url: `/api/v1/admin/slack-channels/${CHANNEL}`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockPrisma.slackChannel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ agentKey: 'customAgent', isActive: false }),
      })
    );
    await app.close();
  });

  it('re-validates the team and re-syncs org on a teamId change', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.slackChannel.findUnique.mockResolvedValue({
      agentKey: 'channelAssistant',
      id: CHANNEL,
      isActive: true,
      orgId: 'org-1',
      teamId: TEAM,
    });
    const NEW_TEAM = '33333333-3333-4333-8333-333333333333';
    mockPrisma.team.findUnique.mockResolvedValue({ id: NEW_TEAM, orgId: 'org-2' });
    mockPrisma.slackChannel.update.mockResolvedValue({
      id: CHANNEL,
      teamId: NEW_TEAM,
      workspace: { id: 'ws-1' },
    });
    const res = await app.inject({
      body: { teamId: NEW_TEAM },
      headers: AUTH,
      method: 'PATCH',
      url: `/api/v1/admin/slack-channels/${CHANNEL}`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockPrisma.slackChannel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orgId: 'org-2', teamId: NEW_TEAM }),
      })
    );
    await app.close();
  });

  it('deletes a channel', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.slackChannel.findUnique.mockResolvedValue({
      id: CHANNEL,
      slackChannelId: 'C123',
      teamId: TEAM,
    });
    const res = await app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/admin/slack-channels/${CHANNEL}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.deleted).toBe(true);
    expect(mockPrisma.slackChannel.delete).toHaveBeenCalled();
    await app.close();
  });

  it('returns the budget (cap + usage)', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.slackChannel.findUnique.mockResolvedValue({
      id: CHANNEL,
      monthlyBudgetUsdCents: 5000,
      name: 'general',
      teamId: TEAM,
    });
    mockPrisma.channelMonthlyUsage.findUnique.mockResolvedValue({
      costUsdAccrued: '2.25',
      runsCompleted: 4,
      yearMonth: '2026-06',
    });
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/admin/slack-channels/${CHANNEL}/budget`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.monthlyBudgetUsdCents).toBe(5000);
    expect(body.currentMonthUsage.costUsdAccrued).toBe(2.25);
    await app.close();
  });

  it('rejects a non-admin write (POST)', async () => {
    const { app } = await buildApp('ENGINEER');
    const res = await app.inject({
      body: { slackChannelId: 'C123', slackTeamId: 'T123', teamId: TEAM },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/admin/slack-channels',
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects a non-admin write (DELETE)', async () => {
    const { app } = await buildApp('ENGINEER');
    const res = await app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/admin/slack-channels/${CHANNEL}`,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
