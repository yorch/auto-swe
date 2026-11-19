import { describe, expect, it, vi } from 'vitest';
import { can, heldScope, type PermissionsDb } from './load.js';
import type { Actor } from './types.js';

const USER: Actor = { id: 'u1', kind: 'user', role: 'USER' };
const ADMIN: Actor = { id: 'admin', kind: 'user', role: 'ADMIN' };

interface Fixture {
  teamMemberships?: Array<{
    role: string;
    teamId: string;
    team: { id: string; isActive: boolean; orgId?: string };
  }>;
  orgMemberships?: Array<{ orgId: string; role: string }>;
  teams?: Array<{ id: string; isActive: boolean; orgId: string }>;
  /** Membership rows by team, for `loadStanding`'s `teamId in` query. */
  byTeam?: Array<{ role: string; teamId: string }>;
}

function mockDb(f: Fixture = {}) {
  const teamMembershipFindMany = vi.fn(async (args: { where: { teamId?: unknown } }) =>
    args.where.teamId ? (f.byTeam ?? []) : (f.teamMemberships ?? [])
  );
  const orgFindMany = vi.fn(async () => f.orgMemberships ?? []);
  const teamFindMany = vi.fn(
    async (args: {
      where: { id?: { in: string[] }; orgId?: { in: string[] }; isActive?: boolean };
    }) =>
      (f.teams ?? []).filter((t) => {
        const { id, orgId, isActive } = args.where;
        return (
          (!id || id.in.includes(t.id)) &&
          (!orgId || orgId.in.includes(t.orgId)) &&
          (isActive === undefined || t.isActive === isActive)
        );
      })
  );
  const db = {
    organizationMembership: { findMany: orgFindMany },
    team: { findMany: teamFindMany },
    teamMembership: { findMany: teamMembershipFindMany },
  };
  return { db: db as unknown as PermissionsDb, orgFindMany, teamFindMany, teamMembershipFindMany };
}

describe('heldScope', () => {
  it('is everything for platform ADMIN, with no query', async () => {
    const m = mockDb();
    expect(await heldScope(m.db, ADMIN, 'team.repos.manage')).toEqual({
      all: true,
      orgIds: [],
      teamIds: [],
    });
    expect(m.teamMembershipFindMany).not.toHaveBeenCalled();
    expect(m.orgFindMany).not.toHaveBeenCalled();
  });

  it('is nothing for a service principal', async () => {
    const m = mockDb();
    expect(await heldScope(m.db, { id: 'sp', kind: 'principal' }, 'team.launch')).toEqual({
      all: false,
      orgIds: [],
      teamIds: [],
    });
    expect(m.teamMembershipFindMany).not.toHaveBeenCalled();
  });

  it('is the teams where the actor meets the minimum role, active only for a non-read capability', async () => {
    const m = mockDb({
      teamMemberships: [
        { role: 'LEAD', team: { id: 't-lead', isActive: true }, teamId: 't-lead' },
        { role: 'ADMIN', team: { id: 't-admin', isActive: true }, teamId: 't-admin' },
        { role: 'ENGINEER', team: { id: 't-member', isActive: true }, teamId: 't-member' },
        { role: 'LEAD', team: { id: 't-off', isActive: false }, teamId: 't-off' },
      ],
    });
    const held = await heldScope(m.db, USER, 'team.templates.write');
    expect(held.all).toBe(false);
    expect(held.teamIds.sort()).toEqual(['t-admin', 't-lead']);
    expect(held.orgIds).toEqual([]);
    // One membership query, and no organization lookups for a capability no org role confers.
    expect(m.teamMembershipFindMany).toHaveBeenCalledTimes(1);
    expect(m.orgFindMany).not.toHaveBeenCalled();
    expect(m.teamFindMany).not.toHaveBeenCalled();
  });

  it('keeps an inactive team for a read capability', async () => {
    const m = mockDb({
      teamMemberships: [
        { role: 'ENGINEER', team: { id: 't-off', isActive: false }, teamId: 't-off' },
      ],
    });
    expect((await heldScope(m.db, USER, 'team.read')).teamIds).toEqual(['t-off']);
  });

  it('adds the active teams of an organization the actor administers, for a governance capability, in constant queries', async () => {
    const m = mockDb({
      orgMemberships: [
        { orgId: 'o1', role: 'ORG_ADMIN' },
        { orgId: 'o2', role: 'ORG_MEMBER' },
      ],
      teamMemberships: [{ role: 'LEAD', team: { id: 't-lead', isActive: true }, teamId: 't-lead' }],
      teams: [
        { id: 't-a', isActive: true, orgId: 'o1' },
        { id: 't-b', isActive: true, orgId: 'o1' },
        { id: 't-c', isActive: false, orgId: 'o1' },
        { id: 't-d', isActive: true, orgId: 'o2' },
      ],
    });
    const held = await heldScope(m.db, USER, 'team.repos.manage');
    expect(held.teamIds.sort()).toEqual(['t-a', 't-b', 't-lead']);
    expect(held.orgIds).toEqual([]); // a team-scoped capability is filtered by teamIds
    expect(m.teamMembershipFindMany).toHaveBeenCalledTimes(1);
    expect(m.orgFindMany).toHaveBeenCalledTimes(1);
    expect(m.teamFindMany).toHaveBeenCalledTimes(1);
  });

  it('is the organizations where the actor meets an org-scoped capability', async () => {
    const m = mockDb({
      orgMemberships: [
        { orgId: 'o1', role: 'ORG_ADMIN' },
        { orgId: 'o2', role: 'ORG_MEMBER' },
      ],
    });
    expect((await heldScope(m.db, USER, 'org.settings.manage')).orgIds).toEqual(['o1']);
    expect((await heldScope(m.db, USER, 'org.read')).orgIds.sort()).toEqual(['o1', 'o2']);
    expect(m.teamMembershipFindMany).not.toHaveBeenCalled();
  });

  it('is the led teams for the platform-scoped directory lookup', async () => {
    const m = mockDb({
      teamMemberships: [
        { role: 'LEAD', team: { id: 't1', isActive: true }, teamId: 't1' },
        { role: 'LEAD', team: { id: 't2', isActive: false }, teamId: 't2' },
      ],
    });
    expect((await heldScope(m.db, USER, 'platform.users.directory.read')).teamIds).toEqual(['t1']);
  });

  it('is empty for a platform-only capability', async () => {
    const m = mockDb();
    expect(await heldScope(m.db, USER, 'platform.users.manage')).toEqual({
      all: false,
      orgIds: [],
      teamIds: [],
    });
  });
});

describe('can', () => {
  it('loads standing for the named team and decides', async () => {
    const m = mockDb({
      byTeam: [{ role: 'LEAD', teamId: 't1' }],
      teams: [{ id: 't1', isActive: true, orgId: 'o1' }],
    });
    expect(await can(m.db, USER, 'team.templates.write', { teamId: 't1' })).toEqual({
      allowed: true,
      authority: 'team-role',
    });
  });

  it('applies the org rule through the team’s organization', async () => {
    const m = mockDb({
      orgMemberships: [{ orgId: 'o1', role: 'ORG_ADMIN' }],
      teams: [{ id: 't1', isActive: true, orgId: 'o1' }],
    });
    expect(await can(m.db, USER, 'team.repos.manage', { teamId: 't1' })).toEqual({
      allowed: true,
      authority: 'org-admin',
    });
    expect(await can(m.db, USER, 'team.templates.write', { teamId: 't1' })).toMatchObject({
      allowed: false,
    });
  });

  it('refuses a service principal without querying', async () => {
    const m = mockDb();
    const d = await can(m.db, { id: 'sp', kind: 'principal' }, 'team.launch', { teamId: 't1' });
    expect(d).toMatchObject({ allowed: false, code: 'FORBIDDEN' });
    expect(m.teamFindMany).not.toHaveBeenCalled();
  });

  it('answers an anyTeam question from every membership', async () => {
    const m = mockDb({
      teamMemberships: [
        { role: 'LEAD', team: { id: 't1', isActive: true, orgId: 'o1' }, teamId: 't1' },
      ],
    });
    expect(await can(m.db, USER, 'platform.users.directory.read', { anyTeam: true })).toEqual({
      allowed: true,
      authority: 'team-role',
    });
  });

  it('asks platform ADMIN about a team with no membership and records platform-admin', async () => {
    const m = mockDb({ teams: [{ id: 't1', isActive: false, orgId: 'o1' }] });
    expect(await can(m.db, ADMIN, 'team.secrets.manage', { teamId: 't1' })).toEqual({
      allowed: true,
      authority: 'platform-admin',
    });
  });
});

describe('tenant-guard exemption', () => {
  it('reads memberships under a declared exemption, so the real tenant guard does not throw', async () => {
    const { isUnscoped } = await import('../lib/tenantGuard.js');
    const seen: Record<string, boolean> = {};
    const db = {
      organizationMembership: {
        findMany: vi.fn(async () => {
          seen.organizationMembership = isUnscoped('OrganizationMembership');
          return [];
        }),
      },
      team: {
        findMany: vi.fn(async () => {
          seen.team = isUnscoped('Team');
          return [{ id: 't1', isActive: true, orgId: 'o1' }];
        }),
      },
      teamMembership: {
        findMany: vi.fn(async () => {
          seen.teamMembership = isUnscoped('TeamMembership');
          return [];
        }),
      },
    } as unknown as PermissionsDb;
    await can(db, USER, 'team.repos.manage', { teamId: 't1' });
    await heldScope(db, USER, 'team.repos.manage');
    expect(seen).toEqual({ organizationMembership: true, team: true, teamMembership: true });
  });
});
