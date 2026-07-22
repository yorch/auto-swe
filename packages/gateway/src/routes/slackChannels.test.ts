import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { slackChannelRoutes } from './slackChannels.js';

function newMockPrisma() {
  return {
    channelMonthlyUsage: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    memoryItem: {
      delete: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
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
    workflowRun: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

function newMockTemporal() {
  return {
    deleteChannelAmbientSchedule: vi.fn().mockResolvedValue(undefined),
    deleteChannelReactiveSchedule: vi.fn().mockResolvedValue(undefined),
    getChannelAmbientScheduleStatus: vi
      .fn()
      .mockResolvedValue({ exists: false, nextRunAt: null, paused: false }),
    startReembedMemory: vi.fn().mockResolvedValue(undefined),
    syncChannelAmbientSchedule: vi.fn().mockResolvedValue(undefined),
    syncChannelReactiveSchedule: vi.fn().mockResolvedValue(undefined),
  };
}

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const mockPrisma = newMockPrisma();
  const mockTemporal = newMockTemporal();
  app.decorate('prisma', mockPrisma as unknown as never);
  app.decorate('temporal', mockTemporal as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
  } as unknown as never);
  await app.register(slackChannelRoutes, { prefix: '/api/v1/admin/slack-channels' });
  await app.ready();
  return { app, mockPrisma, mockTemporal };
}

const AUTH = { authorization: 'Bearer fake' };
const TEAM = '11111111-1111-4111-8111-111111111111';
const CHANNEL = '22222222-2222-4222-8222-222222222222';

beforeEach(() => vi.clearAllMocks());

describe('slackChannelRoutes', () => {
  it('lists channels with workspace + current-month usage, batching usage in one query (admin)', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.slackChannel.findMany.mockResolvedValue([
      { id: CHANNEL, name: 'general', teamId: TEAM, workspace: { id: 'ws-1' } },
    ]);
    // Usage is fetched for all channels in ONE findMany, keyed by channelId.
    mockPrisma.channelMonthlyUsage.findMany.mockResolvedValue([
      { channelId: CHANNEL, costUsdAccrued: '1.5', runsCompleted: 3, yearMonth: '2026-06' },
    ]);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/admin/slack-channels',
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.payload).data;
    expect(data[0].id).toBe(CHANNEL);
    expect(data[0].currentMonthUsage.costUsdAccrued).toBe(1.5);
    // No per-channel findUnique loop — usage comes from a single batched findMany.
    expect(mockPrisma.channelMonthlyUsage.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.channelMonthlyUsage.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.channelMonthlyUsage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ channelId: { in: [CHANNEL] } }),
      })
    );
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

  it('400s when the workspace already belongs to a different org than the team', async () => {
    const { app, mockPrisma } = await buildApp();
    // Team is in org-2, but the existing workspace (same slackTeamId) is org-1.
    mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM, orgId: 'org-2' });
    mockPrisma.slackWorkspace.upsert.mockResolvedValue({ id: 'ws-1', orgId: 'org-1' });
    const res = await app.inject({
      body: { slackChannelId: 'C123', slackTeamId: 'T123', teamId: TEAM },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/admin/slack-channels',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('WORKSPACE_ORG_MISMATCH');
    // Never reached the channel-create path.
    expect(mockPrisma.slackChannel.create).not.toHaveBeenCalled();
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

  it('patches a proactivity cooldown override', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.slackChannel.findUnique.mockResolvedValue({
      id: CHANNEL,
      isActive: true,
      orgId: 'org-1',
      reactiveCooldownMinutes: null,
      teamId: TEAM,
    });
    mockPrisma.slackChannel.update.mockResolvedValue({
      id: CHANNEL,
      reactiveCooldownMinutes: 5,
      teamId: TEAM,
      workspace: { id: 'ws-1' },
    });
    const res = await app.inject({
      body: { reactiveCooldownMinutes: 5 },
      headers: AUTH,
      method: 'PATCH',
      url: `/api/v1/admin/slack-channels/${CHANNEL}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.reactiveCooldownMinutes).toBe(5);
    expect(mockPrisma.slackChannel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reactiveCooldownMinutes: 5 }),
      })
    );
    await app.close();
  });

  it('clears a proactivity cooldown override back to the default via null', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.slackChannel.findUnique.mockResolvedValue({
      id: CHANNEL,
      isActive: true,
      orgId: 'org-1',
      reactiveCooldownMinutes: 5,
      teamId: TEAM,
    });
    mockPrisma.slackChannel.update.mockResolvedValue({
      id: CHANNEL,
      reactiveCooldownMinutes: null,
      teamId: TEAM,
      workspace: { id: 'ws-1' },
    });
    const res = await app.inject({
      body: { reactiveCooldownMinutes: null },
      headers: AUTH,
      method: 'PATCH',
      url: `/api/v1/admin/slack-channels/${CHANNEL}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.reactiveCooldownMinutes).toBeNull();
    expect(mockPrisma.slackChannel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reactiveCooldownMinutes: null }),
      })
    );
    await app.close();
  });

  it('rejects a non-positive proactivity cooldown override', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      body: { orgFlagCooldownHours: 0 },
      headers: AUTH,
      method: 'PATCH',
      url: `/api/v1/admin/slack-channels/${CHANNEL}`,
    });
    expect(res.statusCode).toBe(400);
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

  it('syncs the ambient schedule when creating a channel with ambientEnabled + cron', async () => {
    const { app, mockPrisma, mockTemporal } = await buildApp();
    mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM, orgId: 'org-1' });
    mockPrisma.slackWorkspace.upsert.mockResolvedValue({ id: 'ws-1', orgId: 'org-1' });
    mockPrisma.slackChannel.findUnique.mockResolvedValue(null);
    mockPrisma.slackChannel.create.mockResolvedValue({
      ambientCron: '0 9 * * 1',
      ambientEnabled: true,
      id: CHANNEL,
      isActive: true,
      teamId: TEAM,
      workspace: { id: 'ws-1' },
    });
    const res = await app.inject({
      body: {
        ambientCron: '0 9 * * 1',
        ambientEnabled: true,
        slackChannelId: 'C123',
        slackTeamId: 'T123',
        teamId: TEAM,
      },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/admin/slack-channels',
    });
    expect(res.statusCode).toBe(201);
    expect(mockTemporal.syncChannelAmbientSchedule).toHaveBeenCalledWith({
      channelId: CHANNEL,
      cronExpression: '0 9 * * 1',
    });
    expect(mockTemporal.deleteChannelAmbientSchedule).not.toHaveBeenCalled();
    await app.close();
  });

  it('deletes the ambient schedule when creating a channel without ambient mode', async () => {
    const { app, mockPrisma, mockTemporal } = await buildApp();
    mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM, orgId: 'org-1' });
    mockPrisma.slackWorkspace.upsert.mockResolvedValue({ id: 'ws-1', orgId: 'org-1' });
    mockPrisma.slackChannel.findUnique.mockResolvedValue(null);
    mockPrisma.slackChannel.create.mockResolvedValue({
      ambientCron: null,
      ambientEnabled: false,
      id: CHANNEL,
      isActive: true,
      teamId: TEAM,
      workspace: { id: 'ws-1' },
    });
    const res = await app.inject({
      body: { slackChannelId: 'C123', slackTeamId: 'T123', teamId: TEAM },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/admin/slack-channels',
    });
    expect(res.statusCode).toBe(201);
    expect(mockTemporal.syncChannelAmbientSchedule).not.toHaveBeenCalled();
    expect(mockTemporal.deleteChannelAmbientSchedule).toHaveBeenCalledWith(CHANNEL);
    await app.close();
  });

  it('syncs the ambient schedule when patching ambient mode on', async () => {
    const { app, mockPrisma, mockTemporal } = await buildApp();
    mockPrisma.slackChannel.findUnique.mockResolvedValue({
      id: CHANNEL,
      isActive: true,
      orgId: 'org-1',
      teamId: TEAM,
    });
    mockPrisma.slackChannel.update.mockResolvedValue({
      ambientCron: '30 8 * * *',
      ambientEnabled: true,
      id: CHANNEL,
      isActive: true,
      teamId: TEAM,
      workspace: { id: 'ws-1' },
    });
    const res = await app.inject({
      body: { ambientCron: '30 8 * * *', ambientEnabled: true },
      headers: AUTH,
      method: 'PATCH',
      url: `/api/v1/admin/slack-channels/${CHANNEL}`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockTemporal.syncChannelAmbientSchedule).toHaveBeenCalledWith({
      channelId: CHANNEL,
      cronExpression: '30 8 * * *',
    });
    await app.close();
  });

  it('deletes the ambient schedule when patching ambientEnabled off', async () => {
    const { app, mockPrisma, mockTemporal } = await buildApp();
    mockPrisma.slackChannel.findUnique.mockResolvedValue({
      id: CHANNEL,
      isActive: true,
      orgId: 'org-1',
      teamId: TEAM,
    });
    mockPrisma.slackChannel.update.mockResolvedValue({
      ambientCron: '30 8 * * *',
      ambientEnabled: false,
      id: CHANNEL,
      isActive: true,
      teamId: TEAM,
      workspace: { id: 'ws-1' },
    });
    const res = await app.inject({
      body: { ambientEnabled: false },
      headers: AUTH,
      method: 'PATCH',
      url: `/api/v1/admin/slack-channels/${CHANNEL}`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockTemporal.deleteChannelAmbientSchedule).toHaveBeenCalledWith(CHANNEL);
    expect(mockTemporal.syncChannelAmbientSchedule).not.toHaveBeenCalled();
    await app.close();
  });

  it('deletes the ambient schedule when the channel is deactivated', async () => {
    const { app, mockPrisma, mockTemporal } = await buildApp();
    mockPrisma.slackChannel.findUnique.mockResolvedValue({
      id: CHANNEL,
      isActive: true,
      orgId: 'org-1',
      teamId: TEAM,
    });
    // Ambient is still on with a cron, but the channel is now inactive.
    mockPrisma.slackChannel.update.mockResolvedValue({
      ambientCron: '30 8 * * *',
      ambientEnabled: true,
      id: CHANNEL,
      isActive: false,
      teamId: TEAM,
      workspace: { id: 'ws-1' },
    });
    const res = await app.inject({
      body: { isActive: false },
      headers: AUTH,
      method: 'PATCH',
      url: `/api/v1/admin/slack-channels/${CHANNEL}`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockTemporal.deleteChannelAmbientSchedule).toHaveBeenCalledWith(CHANNEL);
    expect(mockTemporal.syncChannelAmbientSchedule).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects an invalid ambientCron on patch', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      body: { ambientCron: 'nope' },
      headers: AUTH,
      method: 'PATCH',
      url: `/api/v1/admin/slack-channels/${CHANNEL}`,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('deletes the ambient schedule when deleting the channel', async () => {
    const { app, mockPrisma, mockTemporal } = await buildApp();
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
    expect(mockTemporal.deleteChannelAmbientSchedule).toHaveBeenCalledWith(CHANNEL);
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

  it('lists a channel memory items, selecting scalar fields (no embedding)', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.slackChannel.findUnique.mockResolvedValue({ id: CHANNEL, teamId: TEAM });
    mockPrisma.memoryItem.findMany.mockResolvedValue([
      {
        agentKey: 'channelAssistant',
        createdAt: '2026-06-24T00:00:00.000Z',
        id: 'mem-1',
        lessonSummary: 'Prefer feature flags',
        metadata: { source: 'slack' },
        rationale: 'Safer rollouts',
      },
    ]);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/admin/slack-channels/${CHANNEL}/memory`,
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.payload).data;
    expect(data[0].id).toBe('mem-1');
    expect(data[0].lessonSummary).toBe('Prefer feature flags');
    // Scoped to this channel's active rows (no includeConsolidated param).
    expect(mockPrisma.memoryItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 200,
        where: { channelId: CHANNEL, consolidatedAt: null },
      })
    );
    // The embedding column must never be selected (Unsupported vector field).
    const select = mockPrisma.memoryItem.findMany.mock.calls[0][0].select;
    expect(select.embedding).toBeUndefined();
    expect(select.id).toBe(true);
    expect(select.consolidatedAt).toBe(true);
    await app.close();
  });

  it('audit feed: queries channel runs by JSON channelId and flattens metadata', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.slackChannel.findUnique.mockResolvedValue({ id: CHANNEL, teamId: TEAM });
    mockPrisma.workflowRun.findMany.mockResolvedValue([
      {
        costUsdAccrued: 0.0123,
        endedAt: '2026-06-24T00:01:00.000Z',
        id: 'run-1',
        specSnapshot: {
          channel: { channelId: CHANNEL, kind: 'mention', userSlackId: 'U9', userText: 'deploy?' },
        },
        startedAt: '2026-06-24T00:00:00.000Z',
        status: 'SUCCESS',
        tokensInputTotal: 100,
        tokensOutputTotal: 50,
      },
    ]);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/admin/slack-channels/${CHANNEL}/audit`,
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.payload).data;
    expect(data[0]).toMatchObject({
      costUsd: 0.0123,
      kind: 'mention',
      runId: 'run-1',
      status: 'SUCCESS',
      userSlackId: 'U9',
      userText: 'deploy?',
    });
    // Matched by the channelId stashed in the Json spec snapshot. With no kind
    // filter, the WHERE carries just the channelId predicate in its AND.
    const where = mockPrisma.workflowRun.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([
      { specSnapshot: { equals: CHANNEL, path: ['channel', 'channelId'] } },
    ]);
    await app.close();
  });

  it('audit feed: pushes the kind filter into the query WHERE (not a post-take JS filter)', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.slackChannel.findUnique.mockResolvedValue({ id: CHANNEL, teamId: TEAM });
    // The DB does the kind filtering now, so the mock returns only the matching row.
    mockPrisma.workflowRun.findMany.mockResolvedValue([
      {
        costUsdAccrued: 0,
        endedAt: null,
        id: 'r-m',
        specSnapshot: { channel: { kind: 'mention' } },
        startedAt: '2026-06-24T00:00:00.000Z',
        status: 'SUCCESS',
        tokensInputTotal: 0,
        tokensOutputTotal: 0,
      },
    ]);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/admin/slack-channels/${CHANNEL}/audit?kind=mention`,
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.payload).data;
    expect(data).toHaveLength(1);
    expect(data[0].runId).toBe('r-m');
    // The kind predicate must be pushed into the WHERE so `take` applies post-filter.
    const where = mockPrisma.workflowRun.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([
      { specSnapshot: { equals: CHANNEL, path: ['channel', 'channelId'] } },
      { specSnapshot: { equals: 'mention', path: ['channel', 'kind'] } },
    ]);
    await app.close();
  });

  it('deletes one memory item belonging to the channel', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.memoryItem.findUnique.mockResolvedValue({ channelId: CHANNEL, id: 'mem-1' });
    const res = await app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/admin/slack-channels/${CHANNEL}/memory/44444444-4444-4444-8444-444444444444`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.deleted).toBe(true);
    expect(mockPrisma.memoryItem.delete).toHaveBeenCalledWith({ where: { id: 'mem-1' } });
    await app.close();
  });

  it('404s deleting a memory item whose channelId does not match the path', async () => {
    const { app, mockPrisma } = await buildApp();
    // Row exists but belongs to a different channel.
    mockPrisma.memoryItem.findUnique.mockResolvedValue({ channelId: 'other-channel', id: 'mem-1' });
    const res = await app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/admin/slack-channels/${CHANNEL}/memory/44444444-4444-4444-8444-444444444444`,
    });
    expect(res.statusCode).toBe(404);
    expect(mockPrisma.memoryItem.delete).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a non-admin memory delete', async () => {
    const { app, mockPrisma } = await buildApp('ENGINEER');
    const res = await app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/admin/slack-channels/${CHANNEL}/memory/44444444-4444-4444-8444-444444444444`,
    });
    expect(res.statusCode).toBe(403);
    expect(mockPrisma.memoryItem.findUnique).not.toHaveBeenCalled();
    await app.close();
  });

  const MEMORY = '44444444-4444-4444-8444-444444444444';

  it('patches a memory item: updates text, audits before/after, re-embeds, returns the row', async () => {
    const { app, mockPrisma, mockTemporal } = await buildApp();
    mockPrisma.memoryItem.findUnique.mockResolvedValue({
      channelId: CHANNEL,
      id: 'mem-1',
      lessonSummary: 'old summary',
      rationale: 'old rationale',
    });
    mockPrisma.memoryItem.update.mockResolvedValue({
      agentKey: 'channelAssistant',
      createdAt: '2026-06-24T00:00:00.000Z',
      id: 'mem-1',
      lessonSummary: 'new summary',
      metadata: { source: 'slack' },
      rationale: 'new rationale',
    });
    const res = await app.inject({
      body: { lessonSummary: 'new summary', rationale: 'new rationale' },
      headers: AUTH,
      method: 'PATCH',
      url: `/api/v1/admin/slack-channels/${CHANNEL}/memory/${MEMORY}`,
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.payload).data;
    expect(data.id).toBe('mem-1');
    expect(data.lessonSummary).toBe('new summary');
    expect(data.rationale).toBe('new rationale');
    // The text fields are updated synchronously.
    expect(mockPrisma.memoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { lessonSummary: 'new summary', rationale: 'new rationale' },
        where: { id: 'mem-1' },
      })
    );
    // Audit captures old → new for both fields.
    expect(mockPrisma.configAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'UPDATE',
          afterJson: { lessonSummary: 'new summary', rationale: 'new rationale' },
          beforeJson: { lessonSummary: 'old summary', rationale: 'old rationale' },
          entityType: 'MemoryItem',
        }),
      })
    );
    // Re-embed is fired with a unique, per-edit workflowId for this memory row.
    expect(mockTemporal.startReembedMemory).toHaveBeenCalledTimes(1);
    const [workflowId, memoryId] = mockTemporal.startReembedMemory.mock.calls[0];
    expect(workflowId).toMatch(/^reembed-mem-mem-1-\d+$/);
    expect(memoryId).toBe('mem-1');
    await app.close();
  });

  it('patches a single field and still re-embeds', async () => {
    const { app, mockPrisma, mockTemporal } = await buildApp();
    mockPrisma.memoryItem.findUnique.mockResolvedValue({
      channelId: CHANNEL,
      id: 'mem-1',
      lessonSummary: 'old summary',
      rationale: 'old rationale',
    });
    mockPrisma.memoryItem.update.mockResolvedValue({
      agentKey: 'channelAssistant',
      createdAt: '2026-06-24T00:00:00.000Z',
      id: 'mem-1',
      lessonSummary: 'new summary',
      metadata: null,
      rationale: 'old rationale',
    });
    const res = await app.inject({
      body: { lessonSummary: 'new summary' },
      headers: AUTH,
      method: 'PATCH',
      url: `/api/v1/admin/slack-channels/${CHANNEL}/memory/${MEMORY}`,
    });
    expect(res.statusCode).toBe(200);
    // Only the provided field is written.
    expect(mockPrisma.memoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lessonSummary: 'new summary' } })
    );
    expect(mockTemporal.startReembedMemory).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('still returns 200 (and persists the edit) when the re-embed start throws', async () => {
    const { app, mockPrisma, mockTemporal } = await buildApp();
    mockPrisma.memoryItem.findUnique.mockResolvedValue({
      channelId: CHANNEL,
      id: 'mem-1',
      lessonSummary: 'old',
      rationale: 'old',
    });
    mockPrisma.memoryItem.update.mockResolvedValue({
      agentKey: 'channelAssistant',
      createdAt: '2026-06-24T00:00:00.000Z',
      id: 'mem-1',
      lessonSummary: 'new',
      metadata: null,
      rationale: 'old',
    });
    mockTemporal.startReembedMemory.mockRejectedValue(new Error('temporal down'));
    const res = await app.inject({
      body: { lessonSummary: 'new' },
      headers: AUTH,
      method: 'PATCH',
      url: `/api/v1/admin/slack-channels/${CHANNEL}/memory/${MEMORY}`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockPrisma.memoryItem.update).toHaveBeenCalled();
    await app.close();
  });

  it('404s patching a memory item whose channelId does not match the path', async () => {
    const { app, mockPrisma, mockTemporal } = await buildApp();
    mockPrisma.memoryItem.findUnique.mockResolvedValue({
      channelId: 'other-channel',
      id: 'mem-1',
      lessonSummary: 'x',
      rationale: 'y',
    });
    const res = await app.inject({
      body: { lessonSummary: 'new' },
      headers: AUTH,
      method: 'PATCH',
      url: `/api/v1/admin/slack-channels/${CHANNEL}/memory/${MEMORY}`,
    });
    expect(res.statusCode).toBe(404);
    expect(mockPrisma.memoryItem.update).not.toHaveBeenCalled();
    expect(mockTemporal.startReembedMemory).not.toHaveBeenCalled();
    await app.close();
  });

  it('400s a memory patch with neither field provided', async () => {
    const { app, mockPrisma } = await buildApp();
    const res = await app.inject({
      body: {},
      headers: AUTH,
      method: 'PATCH',
      url: `/api/v1/admin/slack-channels/${CHANNEL}/memory/${MEMORY}`,
    });
    expect(res.statusCode).toBe(400);
    expect(mockPrisma.memoryItem.findUnique).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a non-admin memory patch', async () => {
    const { app, mockPrisma } = await buildApp('ENGINEER');
    const res = await app.inject({
      body: { lessonSummary: 'new' },
      headers: AUTH,
      method: 'PATCH',
      url: `/api/v1/admin/slack-channels/${CHANNEL}/memory/${MEMORY}`,
    });
    expect(res.statusCode).toBe(403);
    expect(mockPrisma.memoryItem.findUnique).not.toHaveBeenCalled();
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
