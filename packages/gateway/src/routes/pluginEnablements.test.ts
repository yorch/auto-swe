import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocking the barrel avoids instantiating the real PrismaClient (same pattern as teamSecrets.test.ts).
vi.mock('@auto-swe/shared', () => ({}));

import '../test/warmAuthImports.js';
import { pluginEnablementRoutes } from './pluginEnablements.js';

const AUTH = { authorization: 'Bearer fake-jwt' };
const TEAM = '22222222-2222-4222-8222-222222222222';
const OTHER_TEAM = '44444444-4444-4444-8444-444444444444';
const PROFILE_ID = '33333333-3333-4333-8333-333333333333';
const since = new Date('2026-11-17T10:00:00Z');

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const authState = { role: 'ENGINEER', sub: 'user-1' };
  const prisma = {
    agent: { findMany: vi.fn() },
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    harnessProfile: { findMany: vi.fn(), findUnique: vi.fn() },
    organizationMembership: { findMany: vi.fn() },
    pluginEnablement: {
      create: vi.fn(),
      deleteMany: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    team: { findMany: vi.fn(), findUnique: vi.fn() },
    teamMembership: { findMany: vi.fn(), findUnique: vi.fn() },
  };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({
      exp: 9999999999,
      iat: 0,
      role: authState.role,
      sub: authState.sub,
    }),
  } as unknown as never);
  await app.register(pluginEnablementRoutes, { prefix: '/api/v1/teams' });
  await app.ready();
  return { app, authState, prisma };
}

describe('pluginEnablementRoutes', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    ctx = await buildApp();
  });
  afterAll(() => ctx.app.close());
  const asMember = (role: 'ADMIN' | 'ENGINEER' | null, platform = 'ENGINEER') => {
    ctx.authState.role = platform;
    ctx.prisma.teamMembership.findUnique.mockImplementation(async ({ where }) =>
      role && where.userId_teamId.teamId === TEAM ? { role } : null
    );
    // The permissions loader's read of the caller's membership.
    ctx.prisma.teamMembership.findMany.mockResolvedValue(role ? [{ role, teamId: TEAM }] : []);
  };
  beforeEach(() => {
    vi.clearAllMocks();
    ctx.prisma.team.findUnique.mockResolvedValue({ isActive: true });
    // The permissions loader's read of the team itself and of the caller's organizations.
    ctx.prisma.team.findMany.mockResolvedValue([{ id: TEAM, isActive: true, orgId: 'org-1' }]);
    ctx.prisma.organizationMembership.findMany.mockResolvedValue([]);
    ctx.prisma.harnessProfile.findUnique.mockResolvedValue({ id: PROFILE_ID, status: 'OK' });
    ctx.prisma.agent.findMany.mockResolvedValue([]);
    ctx.prisma.pluginEnablement.findMany.mockResolvedValue([]);
  });
  const call = (method: 'GET' | 'PUT' | 'DELETE', url: string) =>
    ctx.app.inject({ headers: AUTH, method, url: `/api/v1/teams${url}` });

  describe('GET /:teamId/plugins', () => {
    it('lists approved plugins, plus disabled ones the team holds an enablement for, with status, for any team member', async () => {
      asMember('ENGINEER');
      ctx.prisma.harnessProfile.findMany.mockResolvedValue([
        {
          description: 'A',
          hooksEnabled: true,
          id: PROFILE_ID,
          latestVersion: 2,
          name: 'a-kit',
          status: 'OK',
        },
        {
          description: 'B',
          hooksEnabled: false,
          id: 'p2',
          latestVersion: 1,
          name: 'b-kit',
          status: 'DISABLED',
        },
      ]);
      ctx.prisma.pluginEnablement.findMany.mockResolvedValue([
        { createdAt: since, profileId: PROFILE_ID },
      ]);
      const res = await call('GET', `/${TEAM}/plugins`);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([
        {
          description: 'A',
          enabled: true,
          enabledAt: since.toISOString(),
          hooksEnabled: true,
          latestVersion: 2,
          name: 'a-kit',
          status: 'OK',
        },
        {
          description: 'B',
          enabled: false,
          enabledAt: null,
          hooksEnabled: false,
          latestVersion: 1,
          name: 'b-kit',
          status: 'DISABLED',
        },
      ]);
      expect(ctx.prisma.harnessProfile.findMany.mock.calls[0]?.[0].where).toEqual({
        OR: [{ status: 'OK' }, { id: { in: [PROFILE_ID] } }],
      });
      expect(ctx.prisma.pluginEnablement.findMany.mock.calls[0]?.[0].where).toEqual({
        teamId: TEAM,
      });
    });

    it('refuses a non-member', async () => {
      asMember(null);
      expect((await call('GET', `/${TEAM}/plugins`)).statusCode).toBe(403);
      asMember('ENGINEER');
      expect((await call('GET', `/${OTHER_TEAM}/plugins`)).statusCode).toBe(403);
    });
  });

  describe('PUT /:teamId/plugins/:name', () => {
    it('enables a plugin for the team and audits it', async () => {
      asMember('ADMIN');
      ctx.prisma.pluginEnablement.findFirst.mockResolvedValue(null);
      ctx.prisma.pluginEnablement.create.mockResolvedValue({ createdAt: since });
      const res = await call('PUT', `/${TEAM}/plugins/a-kit`);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({
        enabled: true,
        enabledAt: since.toISOString(),
        name: 'a-kit',
      });
      expect(ctx.prisma.pluginEnablement.create.mock.calls[0]?.[0].data).toEqual({
        enabledById: 'user-1',
        profileId: PROFILE_ID,
        teamId: TEAM,
      });
      expect(ctx.prisma.configAuditLog.create.mock.calls[0]?.[0].data).toMatchObject({
        action: 'CREATE',
        entityType: 'PluginEnablement',
      });
    });

    it('is idempotent', async () => {
      asMember('ADMIN');
      ctx.prisma.pluginEnablement.findFirst.mockResolvedValue({ createdAt: since });
      const res = await call('PUT', `/${TEAM}/plugins/a-kit`);
      expect(res.statusCode).toBe(200);
      expect(ctx.prisma.pluginEnablement.create).not.toHaveBeenCalled();
      expect(ctx.prisma.configAuditLog.create).not.toHaveBeenCalled();
    });

    it('answers 409 for a disabled profile and 404 for an unknown one', async () => {
      asMember('ADMIN');
      ctx.prisma.harnessProfile.findUnique.mockResolvedValueOnce({
        id: PROFILE_ID,
        status: 'DISABLED',
      });
      const disabled = await call('PUT', `/${TEAM}/plugins/a-kit`);
      expect(disabled.statusCode).toBe(409);
      expect(disabled.json().error.code).toBe('HARNESS_PROFILE_DISABLED');
      ctx.prisma.harnessProfile.findUnique.mockResolvedValueOnce(null);
      expect((await call('PUT', `/${TEAM}/plugins/nope`)).statusCode).toBe(404);
      expect(ctx.prisma.pluginEnablement.create).not.toHaveBeenCalled();
    });

    it('takes the team ADMIN role: a plain member is refused, a platform admin passes', async () => {
      asMember('ENGINEER');
      expect((await call('PUT', `/${TEAM}/plugins/a-kit`)).statusCode).toBe(403);
      asMember(null, 'ADMIN');
      ctx.prisma.pluginEnablement.findFirst.mockResolvedValue({ createdAt: since });
      expect((await call('PUT', `/${TEAM}/plugins/a-kit`)).statusCode).toBe(200);
      expect(ctx.prisma.pluginEnablement.create).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /:teamId/plugins/:name', () => {
    it('disables the plugin and names the agents it strands', async () => {
      asMember('ADMIN');
      ctx.prisma.pluginEnablement.deleteMany.mockResolvedValue({ count: 1 });
      ctx.prisma.agent.findMany
        .mockResolvedValueOnce([
          {
            channelId: null,
            key: 'implementer',
            orgId: null,
            scope: 'TEAM',
            teamId: TEAM,
            version: 4,
            workflowTemplateId: null,
          },
        ])
        .mockResolvedValueOnce([]);
      const res = await call('DELETE', `/${TEAM}/plugins/a-kit`);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({
        enabled: false,
        name: 'a-kit',
        strandedAgents: [{ key: 'implementer', version: 4 }],
      });
      expect(ctx.prisma.pluginEnablement.deleteMany.mock.calls[0]?.[0].where).toEqual({
        profileId: PROFILE_ID,
        teamId: TEAM,
      });
      expect(ctx.prisma.agent.findMany.mock.calls[0]?.[0].where).toMatchObject({
        scope: 'TEAM',
        teamId: TEAM,
      });
      expect(ctx.prisma.configAuditLog.create.mock.calls[0]?.[0].data).toMatchObject({
        action: 'DELETE',
        entityType: 'PluginEnablement',
      });
    });

    it('withdraws an enablement for a DISABLED plugin', async () => {
      asMember('ADMIN');
      ctx.prisma.harnessProfile.findUnique.mockResolvedValue({
        id: PROFILE_ID,
        status: 'DISABLED',
      });
      ctx.prisma.pluginEnablement.deleteMany.mockResolvedValue({ count: 1 });
      const res = await call('DELETE', `/${TEAM}/plugins/a-kit`);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.enabled).toBe(false);
    });

    it('is allowed with nothing bound, 404 when it was not enabled, refused for a plain member', async () => {
      asMember('ADMIN');
      ctx.prisma.pluginEnablement.deleteMany.mockResolvedValueOnce({ count: 1 });
      expect((await call('DELETE', `/${TEAM}/plugins/a-kit`)).json().data.strandedAgents).toEqual(
        []
      );
      ctx.prisma.pluginEnablement.deleteMany.mockResolvedValueOnce({ count: 0 });
      expect((await call('DELETE', `/${TEAM}/plugins/a-kit`)).statusCode).toBe(404);
      asMember('ENGINEER');
      expect((await call('DELETE', `/${TEAM}/plugins/a-kit`)).statusCode).toBe(403);
    });
  });
});
