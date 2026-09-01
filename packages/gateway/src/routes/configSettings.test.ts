import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Built inside the factory: vi.mock is hoisted above every top-level binding,
// so handles are taken with vi.mocked() after the import below instead.
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    configPermission: {
      create: vi.fn(async () => ({ id: 'grant-1' })),
      delete: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
    },
    configSetting: {
      create: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
    },
    organizationMembership: { findUnique: vi.fn(async () => null) },
    slackChannel: { findUnique: vi.fn(async () => ({ orgId: 'org-1', teamId: 'team-1' })) },
    team: { findUnique: vi.fn(async () => ({ orgId: 'org-1' })) },
    teamMembership: { findUnique: vi.fn(async () => null) },
    workflowTemplate: {
      findUnique: vi.fn(async () => ({ team: { orgId: 'org-1' }, teamId: 'team-1' })),
    },
  },
}));

const writeAudit = vi.fn(async (..._args: unknown[]) => {});
vi.mock('../lib/systemConfigService.js', () => ({
  writeSystemConfigAudit: (...args: unknown[]) => writeAudit(...args),
}));

import { _resetConfigCacheForTests } from '@auto-swe/shared/config/cache';
import { prisma } from '@auto-swe/shared/db';
import { configSettingsRoutes } from './configSettings.js';

const configSetting = vi.mocked(prisma.configSetting);
const configPermission = vi.mocked(prisma.configPermission);
const team = vi.mocked(prisma.team);
const slackChannel = vi.mocked(prisma.slackChannel);
const teamMembership = vi.mocked(prisma.teamMembership);
const orgMembership = vi.mocked(prisma.organizationMembership);

const TEAM_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

/** Token format the fake verifier below reads a role and subject out of. */
function auth(role: 'ADMIN' | 'LEAD' | 'ENGINEER', sub = USER_ID) {
  return { authorization: `Bearer ${role}:${sub}` };
}

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('auth', {
    verifyAccessToken: (token: string) => {
      const [role, sub] = token.split(':');
      return { exp: 9_999_999_999, iat: 0, role, sub };
    },
  } as unknown as never);
  app.decorate('prisma', prisma as unknown as never);
  await app.register(configSettingsRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetConfigCacheForTests();
  configSetting.findMany.mockResolvedValue([] as never);
  configSetting.findFirst.mockResolvedValue(null as never);
  configPermission.findMany.mockResolvedValue([] as never);
  team.findUnique.mockResolvedValue({ orgId: ORG_ID } as never);
  teamMembership.findUnique.mockResolvedValue(null as never);
  orgMembership.findUnique.mockResolvedValue(null as never);
});

describe('GET /config/settings', () => {
  it('returns every definition with its effective value and provenance', async () => {
    const app = await buildApp();
    const res = await app.inject({
      headers: auth('ENGINEER'),
      method: 'GET',
      url: '/api/v1/admin/config/settings',
    });
    expect(res.statusCode).toBe(200);
    const settings = res.json().data as Array<Record<string, unknown>>;
    const history = settings.find((s) => s.key === 'channel.historyMessageLimit');
    expect(history).toMatchObject({
      group: 'channel',
      requiredRole: 'LEAD',
      source: 'DEFAULT',
      value: 30,
    });
    await app.close();
  });

  it('reports the override stored at the requested scope separately from the resolved value', async () => {
    // A TEAM row exists; the caller asked about TEAM. Both the cascade result
    // and the row at that exact scope should be visible — an operator needs to
    // tell "my override won" from "something narrower is overriding me".
    configSetting.findMany.mockResolvedValue([
      { key: 'channel.historyMessageLimit', scope: 'TEAM', value: 42 },
    ] as never);
    const app = await buildApp();
    const res = await app.inject({
      headers: auth('ADMIN'),
      method: 'GET',
      url: `/api/v1/admin/config/settings?scope=TEAM&teamId=${TEAM_ID}`,
    });
    const settings = res.json().data as Array<Record<string, unknown>>;
    expect(settings.find((s) => s.key === 'channel.historyMessageLimit')).toMatchObject({
      overrideAtScope: 42,
      source: 'TEAM',
      value: 42,
    });
    await app.close();
  });
});

describe('GET /config/settings — scoped reads', () => {
  it("refuses to show another team's configuration to a non-member", async () => {
    // Grants authorise writes; a read has no grant to check, and the effective
    // view exposes which images a team's workspaces run and how its assistant is
    // tuned. Membership is the only thing standing between the two.
    const app = await buildApp();
    const res = await app.inject({
      headers: auth('ENGINEER'),
      method: 'GET',
      url: `/api/v1/admin/config/settings?scope=TEAM&teamId=${TEAM_ID}`,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('shows it to a member of that team', async () => {
    teamMembership.findUnique.mockResolvedValue({ role: 'MEMBER' } as never);
    const app = await buildApp();
    const res = await app.inject({
      headers: auth('ENGINEER'),
      method: 'GET',
      url: `/api/v1/admin/config/settings?scope=TEAM&teamId=${TEAM_ID}`,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('lets a platform admin read any scope', async () => {
    const app = await buildApp();
    const res = await app.inject({
      headers: auth('ADMIN'),
      method: 'GET',
      url: `/api/v1/admin/config/settings?scope=TEAM&teamId=${TEAM_ID}`,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('lets anyone read the platform-wide values they already run under', async () => {
    const app = await buildApp();
    const res = await app.inject({
      headers: auth('ENGINEER'),
      method: 'GET',
      url: '/api/v1/admin/config/settings',
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('checks a channel read against the team that owns the channel', async () => {
    slackChannel.findUnique.mockResolvedValue({ orgId: ORG_ID, teamId: TEAM_ID } as never);
    teamMembership.findUnique.mockResolvedValue({ role: 'MEMBER' } as never);
    const app = await buildApp();
    const res = await app.inject({
      headers: auth('ENGINEER'),
      method: 'GET',
      url: `/api/v1/admin/config/settings?scope=CHANNEL&channelId=${ORG_ID}`,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('refuses a scope whose id belongs to nothing rather than silently reading GLOBAL', async () => {
    slackChannel.findUnique.mockResolvedValue(null as never);
    const app = await buildApp();
    const res = await app.inject({
      headers: auth('ENGINEER'),
      method: 'GET',
      url: `/api/v1/admin/config/settings?scope=CHANNEL&channelId=${ORG_ID}`,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('PUT /config/settings/:key', () => {
  it('rejects a key the registry does not define', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: { value: 1 },
      headers: auth('ADMIN'),
      method: 'PUT',
      url: '/api/v1/admin/config/settings/not.a.setting',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('UNKNOWN_SETTING');
    await app.close();
  });

  it("validates against the definition's own schema, not a separate body schema", async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: { value: -3 },
      headers: auth('ADMIN'),
      method: 'PUT',
      url: '/api/v1/admin/config/settings/channel.historyMessageLimit',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('SETTING_INVALID');
    expect(configSetting.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses a scope the definition does not allow', async () => {
    // workspace.blockMetadata is a security control: platform-wide only.
    const app = await buildApp();
    const res = await app.inject({
      body: { value: false },
      headers: auth('ADMIN'),
      method: 'PUT',
      url: `/api/v1/admin/config/settings/workspace.blockMetadata?scope=TEAM&teamId=${TEAM_ID}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('SCOPE_NOT_ALLOWED');
    await app.close();
  });

  it('lets an admin write and records an audit entry', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: { value: 12 },
      headers: auth('ADMIN'),
      method: 'PUT',
      url: '/api/v1/admin/config/settings/channel.historyMessageLimit',
    });
    expect(res.statusCode).toBe(200);
    expect(configSetting.create).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        action: 'CREATE',
        // The shared audit-log table renders `changedFields`; without it the
        // Fields column is blank for every registry write.
        afterJson: expect.objectContaining({ changedFields: ['channel.historyMessageLimit'] }),
        entityType: 'ConfigSetting',
      })
    );
    await app.close();
  });

  it('updates in place rather than creating a second row for the same scope', async () => {
    configSetting.findFirst.mockResolvedValue({ id: 'row-1', value: 9 } as never);
    const app = await buildApp();
    const res = await app.inject({
      body: { value: 12 },
      headers: auth('ADMIN'),
      method: 'PUT',
      url: '/api/v1/admin/config/settings/channel.historyMessageLimit',
    });
    expect(res.statusCode).toBe(200);
    expect(configSetting.update).toHaveBeenCalledTimes(1);
    expect(configSetting.create).not.toHaveBeenCalled();
    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: 'UPDATE', beforeJson: { value: 9 } })
    );
    await app.close();
  });

  it('denies a lead with no grant', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: { value: 12 },
      headers: auth('LEAD'),
      method: 'PUT',
      url: `/api/v1/admin/config/settings/channel.historyMessageLimit?scope=TEAM&teamId=${TEAM_ID}`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('NO_GRANT');
    await app.close();
  });

  it('lets a granted lead write their own team without an admin in the loop', async () => {
    configPermission.findMany.mockResolvedValue([
      {
        keyPattern: 'channel.*',
        orgId: null,
        role: 'LEAD',
        scope: 'TEAM',
        teamId: TEAM_ID,
        userId: null,
      },
    ] as never);
    const app = await buildApp();
    const res = await app.inject({
      body: { value: 12 },
      headers: auth('LEAD'),
      method: 'PUT',
      url: `/api/v1/admin/config/settings/channel.historyMessageLimit?scope=TEAM&teamId=${TEAM_ID}`,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('checks a channel write against the team that owns the channel', async () => {
    // The grant is on TEAM_ID; the channel belongs to it, so a TEAM grant must
    // reach the channel beneath it.
    slackChannel.findUnique.mockResolvedValue({ orgId: ORG_ID, teamId: TEAM_ID } as never);
    configPermission.findMany.mockResolvedValue([
      {
        keyPattern: 'channel.*',
        orgId: null,
        role: 'LEAD',
        scope: 'TEAM',
        teamId: TEAM_ID,
        userId: null,
      },
    ] as never);
    const app = await buildApp();
    const res = await app.inject({
      body: { value: 12 },
      headers: auth('LEAD'),
      method: 'PUT',
      url: `/api/v1/admin/config/settings/channel.historyMessageLimit?scope=CHANNEL&channelId=${ORG_ID}`,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('does not let a team grant reach a channel owned by a different team', async () => {
    slackChannel.findUnique.mockResolvedValue({ orgId: ORG_ID, teamId: 'other-team' } as never);
    configPermission.findMany.mockResolvedValue([
      {
        keyPattern: 'channel.*',
        orgId: null,
        role: 'LEAD',
        scope: 'TEAM',
        teamId: TEAM_ID,
        userId: null,
      },
    ] as never);
    const app = await buildApp();
    const res = await app.inject({
      body: { value: 12 },
      headers: auth('LEAD'),
      method: 'PUT',
      url: `/api/v1/admin/config/settings/channel.historyMessageLimit?scope=CHANNEL&channelId=${ORG_ID}`,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('holds the requiredRole floor even when a wildcard grant matches', async () => {
    configPermission.findMany.mockResolvedValue([
      { keyPattern: '*', orgId: null, role: 'LEAD', scope: 'GLOBAL', teamId: null, userId: null },
    ] as never);
    const app = await buildApp();
    const res = await app.inject({
      body: { value: 'alpine/git:1.0' },
      headers: auth('LEAD'),
      method: 'PUT',
      url: '/api/v1/admin/config/settings/workspace.gitHelperImage',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ROLE_TOO_LOW');
    await app.close();
  });

  it('rejects a scoped write that names no id for that scope', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: { value: 12 },
      headers: auth('ADMIN'),
      method: 'PUT',
      url: '/api/v1/admin/config/settings/channel.historyMessageLimit?scope=TEAM',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('DELETE /config/settings/:key', () => {
  it('removes the override so the key falls back down the cascade', async () => {
    configSetting.findFirst.mockResolvedValue({ id: 'row-1', value: 9 } as never);
    const app = await buildApp();
    const res = await app.inject({
      headers: auth('ADMIN'),
      method: 'DELETE',
      url: '/api/v1/admin/config/settings/channel.historyMessageLimit',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.cleared).toBe(true);
    expect(configSetting.delete).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('is a no-op, not an error, when there was nothing stored', async () => {
    const app = await buildApp();
    const res = await app.inject({
      headers: auth('ADMIN'),
      method: 'DELETE',
      url: '/api/v1/admin/config/settings/channel.historyMessageLimit',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.cleared).toBe(false);
    expect(configSetting.delete).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
    await app.close();
  });

  it('still enforces authorisation', async () => {
    const app = await buildApp();
    const res = await app.inject({
      headers: auth('ENGINEER'),
      method: 'DELETE',
      url: '/api/v1/admin/config/settings/channel.historyMessageLimit',
    });
    expect(res.statusCode).toBe(403);
    expect(configSetting.delete).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('grants', () => {
  it('stays ADMIN-only so the permission model cannot widen itself', async () => {
    configPermission.findMany.mockResolvedValue([
      { keyPattern: '*', orgId: null, role: 'LEAD', scope: 'GLOBAL', teamId: null, userId: null },
    ] as never);
    const app = await buildApp();
    const res = await app.inject({
      body: { keyPattern: '*', role: 'LEAD', scope: 'GLOBAL' },
      headers: auth('LEAD'),
      method: 'POST',
      url: '/api/v1/admin/config/grants',
    });
    expect(res.statusCode).toBe(403);
    expect(configPermission.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('requires exactly one grantee', async () => {
    const app = await buildApp();
    const both = await app.inject({
      body: { keyPattern: 'channel.*', role: 'LEAD', scope: 'GLOBAL', userId: USER_ID },
      headers: auth('ADMIN'),
      method: 'POST',
      url: '/api/v1/admin/config/grants',
    });
    expect(both.statusCode).toBe(400);

    const neither = await app.inject({
      body: { keyPattern: 'channel.*', scope: 'GLOBAL' },
      headers: auth('ADMIN'),
      method: 'POST',
      url: '/api/v1/admin/config/grants',
    });
    expect(neither.statusCode).toBe(400);
    await app.close();
  });

  it('requires the matching id for a scoped grant', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: { keyPattern: 'channel.*', role: 'LEAD', scope: 'TEAM' },
      headers: auth('ADMIN'),
      method: 'POST',
      url: '/api/v1/admin/config/grants',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('creates a valid grant and audits it', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: { keyPattern: 'channel.*', role: 'LEAD', scope: 'TEAM', teamId: TEAM_ID },
      headers: auth('ADMIN'),
      method: 'POST',
      url: '/api/v1/admin/config/grants',
    });
    expect(res.statusCode).toBe(200);
    expect(configPermission.create).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ entityType: 'ConfigPermission' })
    );
    await app.close();
  });
});
