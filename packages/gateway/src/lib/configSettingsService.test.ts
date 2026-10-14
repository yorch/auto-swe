import type { PrismaClient } from '@auto-swe/shared';
import type { ConfigActor, ConfigGrant } from '@auto-swe/shared/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cache = vi.hoisted(() => ({ invalidateSettingsCache: vi.fn() }));
vi.mock('@auto-swe/shared/config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  invalidateSettingsCache: cache.invalidateSettingsCache,
}));

import {
  canReadScope,
  clearSetting,
  loadGrantsForActor,
  resolveScopeTenant,
  type ScopeSelector,
  scopeColumns,
  setSetting,
} from './configSettingsService.js';

const ORG_ID = '00000000-0000-4000-8000-0000000000a1';
const TEAM_ID = '00000000-0000-4000-8000-0000000000b1';
const OTHER_TEAM_ID = '00000000-0000-4000-8000-0000000000b2';

// Real registry keys, so the tests exercise the actual definitions:
//   LEAD_KEY        requiredRole LEAD, overridable at CHANNEL / TEAM / ORGANIZATION, int 1..200
//   ADMIN_KEY       requiredRole ADMIN, overridable at TEAM / ORGANIZATION, boolean
//   GLOBAL_ONLY_KEY requiredRole ADMIN, overridable nowhere below GLOBAL
const LEAD_KEY = 'channel.historyMessageLimit';
const ADMIN_KEY = 'github.ciFailureTriggersEnabled';
const GLOBAL_ONLY_KEY = 'github.repositoryHosts';

const LEAD: ConfigActor = { id: 'user-1', role: 'LEAD' };
const ENGINEER: ConfigActor = { id: 'user-1', role: 'ENGINEER' };
const ADMIN: ConfigActor = { id: 'admin-1', role: 'ADMIN' };

const TEAM: ScopeSelector = { scope: 'TEAM', teamId: TEAM_ID };

const grant = (over: Partial<ConfigGrant>): ConfigGrant => ({
  keyPattern: '*',
  orgId: null,
  role: null,
  scope: 'GLOBAL',
  teamId: null,
  userId: null,
  ...over,
});

function makePrisma() {
  return {
    configPermission: { findMany: vi.fn().mockResolvedValue([]) },
    configSetting: {
      create: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    organizationMembership: { findUnique: vi.fn().mockResolvedValue(null) },
    slackChannel: { findUnique: vi.fn().mockResolvedValue(null) },
    team: { findUnique: vi.fn().mockResolvedValue({ orgId: ORG_ID }) },
    teamMembership: { findUnique: vi.fn().mockResolvedValue(null) },
    workflowTemplate: { findUnique: vi.fn().mockResolvedValue(null) },
  };
}

type FakePrisma = ReturnType<typeof makePrisma>;
const asPrisma = (p: FakePrisma) => p as unknown as PrismaClient;

let prisma: FakePrisma;

beforeEach(() => {
  vi.clearAllMocks();
  prisma = makePrisma();
});

describe('scopeColumns', () => {
  it('maps GLOBAL to every scope column being null', () => {
    expect(scopeColumns({ scope: 'GLOBAL' })).toEqual({
      channelId: null,
      orgId: null,
      teamId: null,
      workflowTemplateId: null,
    });
  });

  it('sets only the column of the selected scope', () => {
    expect(scopeColumns(TEAM)).toEqual({
      channelId: null,
      orgId: null,
      teamId: TEAM_ID,
      workflowTemplateId: null,
    });
  });

  it.each<[string, ScopeSelector]>([
    ['ORGANIZATION', { scope: 'ORGANIZATION' }],
    ['TEAM', { scope: 'TEAM' }],
    ['CHANNEL', { scope: 'CHANNEL' }],
    ['WORKFLOW_TEMPLATE', { scope: 'WORKFLOW_TEMPLATE' }],
  ])('returns null for a %s selector that names no id', (_name, selector) => {
    expect(scopeColumns(selector)).toBeNull();
  });
});

describe('resolveScopeTenant', () => {
  it('resolves GLOBAL to no tenant without reading the database', async () => {
    expect(await resolveScopeTenant(asPrisma(prisma), { scope: 'GLOBAL' })).toEqual({});
    expect(prisma.team.findUnique).not.toHaveBeenCalled();
  });

  it('resolves a TEAM scope to the team and the org it belongs to', async () => {
    expect(await resolveScopeTenant(asPrisma(prisma), TEAM)).toEqual({
      orgId: ORG_ID,
      teamId: TEAM_ID,
    });
  });

  it('resolves a CHANNEL scope to the owning channel team and org', async () => {
    prisma.slackChannel.findUnique.mockResolvedValue({ orgId: ORG_ID, teamId: OTHER_TEAM_ID });
    expect(
      await resolveScopeTenant(asPrisma(prisma), { channelId: 'chan-1', scope: 'CHANNEL' })
    ).toEqual({ orgId: ORG_ID, teamId: OTHER_TEAM_ID });
  });

  it('resolves a WORKFLOW_TEMPLATE scope through the template team and its org', async () => {
    prisma.workflowTemplate.findUnique.mockResolvedValue({
      team: { orgId: ORG_ID },
      teamId: TEAM_ID,
    });
    expect(
      await resolveScopeTenant(asPrisma(prisma), {
        scope: 'WORKFLOW_TEMPLATE',
        workflowTemplateId: 'tpl-1',
      })
    ).toEqual({ orgId: ORG_ID, teamId: TEAM_ID });
  });
});

describe('loadGrantsForActor', () => {
  it("loads the actor's own grants and the grants for their role", async () => {
    await loadGrantsForActor(asPrisma(prisma), LEAD);
    expect(prisma.configPermission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ userId: 'user-1' }, { role: 'LEAD' }] },
      })
    );
  });
});

describe('canReadScope', () => {
  it('lets a platform ADMIN read a team scope they do not belong to', async () => {
    expect(await canReadScope(asPrisma(prisma), ADMIN, TEAM)).toBe(true);
    expect(prisma.teamMembership.findUnique).not.toHaveBeenCalled();
  });

  it('lets any authenticated user read GLOBAL values', async () => {
    expect(await canReadScope(asPrisma(prisma), ENGINEER, { scope: 'GLOBAL' })).toBe(true);
    expect(prisma.team.findUnique).not.toHaveBeenCalled();
  });

  it('lets a member of the owning team read that team scope', async () => {
    prisma.teamMembership.findUnique.mockResolvedValue({ role: 'ENGINEER' });
    expect(await canReadScope(asPrisma(prisma), ENGINEER, TEAM)).toBe(true);
  });

  it('lets a member of the owning org read a team scope in it', async () => {
    prisma.organizationMembership.findUnique.mockResolvedValue({ role: 'ORG_MEMBER' });
    expect(await canReadScope(asPrisma(prisma), ENGINEER, TEAM)).toBe(true);
  });

  it('refuses a user with neither team nor org membership', async () => {
    expect(await canReadScope(asPrisma(prisma), ENGINEER, TEAM)).toBe(false);
  });

  it('refuses a team-scope read that names no team, even for a team member', async () => {
    // With no team id the tenant resolves to nothing without a lookup (Prisma throws on
    // `where: { id: undefined }`), and the read is refused before any membership is consulted.
    prisma.teamMembership.findUnique.mockResolvedValue({ role: 'ENGINEER' });
    expect(await canReadScope(asPrisma(prisma), ENGINEER, { scope: 'TEAM' })).toBe(false);
    expect(prisma.team.findUnique).not.toHaveBeenCalled();
    expect(prisma.teamMembership.findUnique).not.toHaveBeenCalled();
  });
});

describe('setSetting authorisation', () => {
  it('lets a platform ADMIN write an ADMIN-floor key without consulting grants', async () => {
    const result = await setSetting(asPrisma(prisma), ADMIN, ADMIN_KEY, TEAM, true);
    expect(result).toMatchObject({ after: true });
    expect(prisma.configPermission.findMany).not.toHaveBeenCalled();
  });

  it('refuses a LEAD who holds no grant with NO_GRANT and writes nothing', async () => {
    const result = await setSetting(asPrisma(prisma), LEAD, LEAD_KEY, TEAM, 50);
    expect(result).toEqual({
      denial: expect.objectContaining({ allowed: false, code: 'NO_GRANT' }),
    });
    expect(prisma.configSetting.create).not.toHaveBeenCalled();
    expect(prisma.configSetting.updateMany).not.toHaveBeenCalled();
  });

  it('lets a user write a key at a team they hold a matching grant for', async () => {
    prisma.configPermission.findMany.mockResolvedValue([
      grant({ keyPattern: 'channel.*', scope: 'TEAM', teamId: TEAM_ID, userId: 'user-1' }),
    ]);
    const result = await setSetting(asPrisma(prisma), LEAD, LEAD_KEY, TEAM, 50);
    expect(result).toMatchObject({ after: 50 });
  });

  it('refuses a grant that names a different team than the write lands in', async () => {
    prisma.configPermission.findMany.mockResolvedValue([
      grant({ keyPattern: LEAD_KEY, scope: 'TEAM', teamId: OTHER_TEAM_ID, userId: 'user-1' }),
    ]);
    const result = await setSetting(asPrisma(prisma), LEAD, LEAD_KEY, TEAM, 50);
    expect(result).toEqual({
      denial: expect.objectContaining({ code: 'NO_GRANT' }),
    });
  });

  it('refuses a grant whose key pattern does not cover the key', async () => {
    prisma.configPermission.findMany.mockResolvedValue([
      grant({ keyPattern: 'workflow.*', scope: 'GLOBAL', role: 'LEAD' }),
    ]);
    const result = await setSetting(asPrisma(prisma), LEAD, LEAD_KEY, TEAM, 50);
    expect(result).toEqual({
      denial: expect.objectContaining({ code: 'NO_GRANT' }),
    });
  });

  it('lets a role grant cover every member of that role', async () => {
    prisma.configPermission.findMany.mockResolvedValue([
      grant({ keyPattern: '*', role: 'LEAD', scope: 'GLOBAL' }),
    ]);
    const result = await setSetting(asPrisma(prisma), LEAD, LEAD_KEY, TEAM, 50);
    expect(result).toMatchObject({ after: 50 });
  });

  it('refuses an ENGINEER on a LEAD-floor key even with a deployment-wide grant', async () => {
    prisma.configPermission.findMany.mockResolvedValue([
      grant({ keyPattern: '*', userId: 'user-1', scope: 'GLOBAL' }),
    ]);
    const result = await setSetting(asPrisma(prisma), ENGINEER, LEAD_KEY, TEAM, 50);
    expect(result).toEqual({
      denial: expect.objectContaining({ code: 'ROLE_TOO_LOW' }),
    });
    expect(prisma.configSetting.create).not.toHaveBeenCalled();
  });

  it('refuses a LEAD on an ADMIN-floor key even with a grant covering it', async () => {
    prisma.configPermission.findMany.mockResolvedValue([
      grant({ keyPattern: '*', userId: 'user-1', scope: 'GLOBAL' }),
    ]);
    const result = await setSetting(asPrisma(prisma), LEAD, ADMIN_KEY, TEAM, true);
    expect(result).toEqual({
      denial: expect.objectContaining({ code: 'ROLE_TOO_LOW' }),
    });
  });

  it('refuses a scope the definition does not list as overridable, even for ADMIN', async () => {
    const result = await setSetting(asPrisma(prisma), ADMIN, GLOBAL_ONLY_KEY, TEAM, []);
    expect(result).toEqual({
      denial: expect.objectContaining({ code: 'SCOPE_NOT_ALLOWED' }),
    });
    expect(prisma.configSetting.create).not.toHaveBeenCalled();
  });

  it('refuses an unknown key with UNKNOWN_SETTING before touching the database', async () => {
    const result = await setSetting(asPrisma(prisma), ADMIN, 'no.such.key', TEAM, 1);
    expect(result).toEqual({
      denial: expect.objectContaining({ code: 'UNKNOWN_SETTING' }),
    });
    expect(prisma.configSetting.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a non-GLOBAL write that names no id, with SCOPE_NOT_ALLOWED', async () => {
    // No tenant lookup happens for a selector without its id: under real Prisma a
    // `findUnique` with an undefined id throws, which would surface as a 500.
    const result = await setSetting(
      asPrisma(prisma),
      ADMIN,
      ADMIN_KEY,
      { scope: 'TEAM' } as ScopeSelector,
      true
    );
    expect(result).toEqual({
      denial: {
        allowed: false,
        code: 'SCOPE_NOT_ALLOWED',
        message: 'A TEAM override needs the matching id.',
      },
    });
    expect(prisma.team.findUnique).not.toHaveBeenCalled();
    expect(prisma.configSetting.create).not.toHaveBeenCalled();
  });
});

describe('setSetting validation', () => {
  it('rejects a value that fails the definition schema and writes nothing', async () => {
    const result = await setSetting(asPrisma(prisma), ADMIN, LEAD_KEY, TEAM, 0);
    expect(result).toHaveProperty('validationError');
    expect(prisma.configSetting.findFirst).not.toHaveBeenCalled();
    expect(prisma.configSetting.create).not.toHaveBeenCalled();
  });

  it('rejects a wrong-typed value for a boolean setting', async () => {
    const result = await setSetting(asPrisma(prisma), ADMIN, ADMIN_KEY, TEAM, 'yes');
    expect(result).toHaveProperty('validationError');
    expect(prisma.configSetting.create).not.toHaveBeenCalled();
  });
});

describe('setSetting write path', () => {
  it('creates the row when nothing is stored at the scope', async () => {
    const result = await setSetting(asPrisma(prisma), ADMIN, LEAD_KEY, TEAM, 50);
    expect(prisma.configSetting.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: LEAD_KEY,
        scope: 'TEAM',
        teamId: TEAM_ID,
        updatedById: 'admin-1',
        value: 50,
      }),
    });
    expect(prisma.configSetting.updateMany).not.toHaveBeenCalled();
    expect(cache.invalidateSettingsCache).toHaveBeenCalled();
    expect(result).toEqual({ after: 50, before: undefined });
  });

  it('updates the stored row in place and reports the value it replaced', async () => {
    prisma.configSetting.findFirst.mockResolvedValue({ id: 'row-1', value: 20 });
    prisma.configSetting.updateMany.mockResolvedValue({ count: 1 });
    const result = await setSetting(asPrisma(prisma), ADMIN, LEAD_KEY, TEAM, 50);
    expect(prisma.configSetting.updateMany).toHaveBeenCalledWith({
      data: expect.objectContaining({ updatedById: 'admin-1', value: 50 }),
      where: expect.objectContaining({ id: 'row-1', teamId: TEAM_ID }),
    });
    expect(prisma.configSetting.create).not.toHaveBeenCalled();
    expect(result).toEqual({ after: 50, before: 20 });
  });

  it('creates the row afresh when a concurrent clear removed it before the update', async () => {
    prisma.configSetting.findFirst.mockResolvedValue({ id: 'row-1', value: 20 });
    prisma.configSetting.updateMany.mockResolvedValue({ count: 0 });
    const result = await setSetting(asPrisma(prisma), ADMIN, LEAD_KEY, TEAM, 50);
    expect(prisma.configSetting.create).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ after: 50, before: undefined });
  });

  it('updates the winning row when a concurrent writer created it first', async () => {
    const dup = Object.assign(new Error('dup'), { code: 'P2002' });
    prisma.configSetting.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'row-2', value: 30 });
    prisma.configSetting.create.mockRejectedValue(dup);
    prisma.configSetting.updateMany.mockResolvedValue({ count: 1 });
    const result = await setSetting(asPrisma(prisma), ADMIN, LEAD_KEY, TEAM, 50);
    expect(prisma.configSetting.updateMany).toHaveBeenCalledWith({
      data: expect.objectContaining({ value: 50 }),
      where: expect.objectContaining({ id: 'row-2' }),
    });
    expect(result).toEqual({ after: 50, before: 30 });
  });

  it('rethrows a unique-constraint error when no winning row can be found', async () => {
    const dup = Object.assign(new Error('dup'), { code: 'P2002' });
    prisma.configSetting.findFirst.mockResolvedValue(null);
    prisma.configSetting.create.mockRejectedValue(dup);
    await expect(setSetting(asPrisma(prisma), ADMIN, LEAD_KEY, TEAM, 50)).rejects.toBe(dup);
    expect(prisma.configSetting.updateMany).not.toHaveBeenCalled();
  });

  it('rethrows a create failure that is not a unique-constraint violation', async () => {
    prisma.configSetting.findFirst.mockResolvedValue(null);
    prisma.configSetting.create.mockRejectedValue(new Error('connection lost'));
    await expect(setSetting(asPrisma(prisma), ADMIN, LEAD_KEY, TEAM, 50)).rejects.toThrow(
      'connection lost'
    );
    expect(cache.invalidateSettingsCache).not.toHaveBeenCalled();
  });
});

describe('clearSetting', () => {
  it('is a no-op when nothing is stored at the scope', async () => {
    const result = await clearSetting(asPrisma(prisma), ADMIN, LEAD_KEY, TEAM);
    expect(result).toEqual({ before: undefined });
    expect(prisma.configSetting.deleteMany).not.toHaveBeenCalled();
    expect(cache.invalidateSettingsCache).not.toHaveBeenCalled();
  });

  it('removes the stored row and reports the value it held', async () => {
    prisma.configSetting.findFirst.mockResolvedValue({ id: 'row-1', value: 20 });
    prisma.configSetting.deleteMany.mockResolvedValue({ count: 1 });
    const result = await clearSetting(asPrisma(prisma), ADMIN, LEAD_KEY, TEAM);
    expect(prisma.configSetting.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'row-1', teamId: TEAM_ID }),
    });
    expect(cache.invalidateSettingsCache).toHaveBeenCalled();
    expect(result).toEqual({ before: 20 });
  });

  it('treats a concurrent clear that removed the row first as a no-op', async () => {
    prisma.configSetting.findFirst.mockResolvedValue({ id: 'row-1', value: 20 });
    prisma.configSetting.deleteMany.mockResolvedValue({ count: 0 });
    const result = await clearSetting(asPrisma(prisma), ADMIN, LEAD_KEY, TEAM);
    expect(result).toEqual({ before: undefined });
    expect(cache.invalidateSettingsCache).not.toHaveBeenCalled();
  });

  it('refuses an actor without a grant before reading the stored row', async () => {
    const result = await clearSetting(asPrisma(prisma), LEAD, LEAD_KEY, TEAM);
    expect(result).toEqual({
      denial: expect.objectContaining({ code: 'NO_GRANT' }),
    });
    expect(prisma.configSetting.findFirst).not.toHaveBeenCalled();
  });
});
