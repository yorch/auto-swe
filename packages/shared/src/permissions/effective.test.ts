import { describe, expect, it, vi } from 'vitest';
import { effectivePermissions } from './effective.js';
import type { PermissionsDb } from './load.js';
import type { Actor } from './types.js';

const USER = { id: 'u1', kind: 'user', role: 'ENGINEER' } as Extract<Actor, { kind: 'user' }>;
const ADMIN = { id: 'admin', kind: 'user', role: 'ADMIN' } as Extract<Actor, { kind: 'user' }>;

const TEAM_A = { id: 'team-a', isActive: true, name: 'Alpha', orgId: 'org-1', slug: 'alpha' };
const TEAM_B = { id: 'team-b', isActive: true, name: 'Beta', orgId: 'org-1', slug: 'beta' };
const TEAM_C = { id: 'team-c', isActive: true, name: 'Gamma', orgId: 'org-2', slug: 'gamma' };

function mockDb(f: {
  memberOf?: Array<{ role: string; team: typeof TEAM_A }>;
  orgs?: Array<{ orgId: string; role: string; organization: { name: string } }>;
}) {
  const memberOf = f.memberOf ?? [];
  const allTeams = [TEAM_A, TEAM_B, TEAM_C];
  const db = {
    organizationMembership: { findMany: vi.fn(async () => f.orgs ?? []) },
    team: {
      findMany: vi.fn(
        async (args: { where: { id?: { in: string[] }; orgId?: { in: string[] } } }) =>
          allTeams.filter(
            (t) =>
              (!args.where.id || args.where.id.in.includes(t.id)) &&
              (!args.where.orgId || args.where.orgId.in.includes(t.orgId))
          )
      ),
      findUnique: vi.fn(
        async (args: { where: { id: string } }) =>
          allTeams.find((t) => t.id === args.where.id) ?? null
      ),
    },
    teamMembership: {
      findMany: vi.fn(async (args: { where: { teamId?: unknown } }) =>
        args.where.teamId
          ? memberOf.map((m) => ({ role: m.role, teamId: m.team.id }))
          : memberOf.map((m) => ({ role: m.role, team: m.team }))
      ),
    },
  };
  return db as unknown as PermissionsDb;
}

describe('effectivePermissions', () => {
  it('lists the teams and organizations the person belongs to, with the ground of each capability', async () => {
    const db = mockDb({
      memberOf: [{ role: 'ADMIN', team: TEAM_A }],
      orgs: [{ organization: { name: 'Acme' }, orgId: 'org-1', role: 'ORG_MEMBER' }],
    });
    const result = await effectivePermissions(db, USER);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.platformRole).toBe('ENGINEER');
    expect(result.value.teams.map((t) => t.teamId)).toEqual(['team-a']);
    expect(result.value.teams[0]?.role).toBe('ADMIN');
    expect(result.value.teams[0]?.capabilities.length).toBeGreaterThan(0);
    expect(result.value.teams[0]?.capabilities.every((c) => c.authority)).toBe(true);
    expect(result.value.organizations.map((o) => o.orgId)).toEqual(['org-1']);
    expect(result.value.platformCapabilities).not.toContain('team.members.manage');
  });

  it('gives a platform administrator every platform capability', async () => {
    const result = await effectivePermissions(mockDb({}), ADMIN);
    expect(result.ok && result.value.platformCapabilities.length).toBeGreaterThan(0);
  });

  it('includes a named team held only through organization authority, tagged by authority', async () => {
    const db = mockDb({
      orgs: [{ organization: { name: 'Acme' }, orgId: 'org-1', role: 'ORG_ADMIN' }],
    });
    const result = await effectivePermissions(db, USER, { teamId: 'team-b' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const team = result.value.teams[0];
    expect(team?.teamId).toBe('team-b');
    expect(team?.role).toBeNull();
    expect(team?.capabilities.find((c) => c.key === 'team.members.manage')?.authority).toBe(
      'org-admin'
    );
    expect(result.value.organizations.map((o) => o.orgId)).toEqual(['org-1']);
  });

  it('refuses a team without standing the same way whether it exists or not', async () => {
    const db = mockDb({});
    const existing = await effectivePermissions(db, USER, { teamId: 'team-c' });
    const missing = await effectivePermissions(db, USER, { teamId: 'no-such-team' });
    expect(existing).toEqual({ ok: false, reason: 'NO_STANDING' });
    expect(missing).toEqual(existing);
  });
});
