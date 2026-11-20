import { describe, expect, it } from 'vitest';
import { CATALOG, type CapabilityKey } from './catalog/index.js';
import { can, heldScope, type PermissionsDb } from './load.js';
import type { Actor } from './types.js';

/**
 * A list and the action behind it must not disagree. For every catalog key and a matrix of people,
 * `can()` on a resource and `heldScope()` are asked the same question two ways and must agree.
 * The database is a small world held in memory that answers the queries the loader makes.
 */

interface World {
  teams: Array<{ id: string; isActive: boolean; orgId: string }>;
  teamMemberships: Array<{ userId: string; teamId: string; role: string }>;
  orgMemberships: Array<{ userId: string; orgId: string; role: string }>;
}

const world: World = {
  orgMemberships: [
    { orgId: 'A', role: 'ORG_ADMIN', userId: 'orgAdminA' },
    { orgId: 'A', role: 'ORG_MEMBER', userId: 'orgMemberA' },
    { orgId: 'A', role: 'ORG_MEMBER', userId: 'leadA1' },
    { orgId: 'A', role: 'ORG_ADMIN', userId: 'adminAndLeadB' },
    { orgId: 'B', role: 'ORG_ADMIN', userId: 'orgAdminB' },
    { orgId: 'B', role: 'ORG_MEMBER', userId: 'adminAndLeadB' },
  ],
  teamMemberships: [
    { role: 'ADMIN', teamId: 'a1', userId: 'adminA1' },
    { role: 'LEAD', teamId: 'a1', userId: 'leadA1' },
    { role: 'ENGINEER', teamId: 'a1', userId: 'memberA1' },
    { role: 'LEAD', teamId: 'a2', userId: 'leadInactive' },
    { role: 'ADMIN', teamId: 'a2', userId: 'adminInactive' },
    { role: 'LEAD', teamId: 'b1', userId: 'leadB1' },
    { role: 'LEAD', teamId: 'b1', userId: 'adminAndLeadB' },
  ],
  teams: [
    { id: 'a1', isActive: true, orgId: 'A' },
    { id: 'a2', isActive: false, orgId: 'A' },
    { id: 'b1', isActive: true, orgId: 'B' },
  ],
};

const people = [
  'platformAdmin',
  'orgAdminA',
  'orgAdminB',
  'orgMemberA',
  'adminA1',
  'leadA1',
  'memberA1',
  'leadInactive',
  'adminInactive',
  'leadB1',
  'adminAndLeadB',
  'stranger',
];

function actorOf(name: string): Actor {
  return { id: name, kind: 'user', role: name === 'platformAdmin' ? 'ADMIN' : 'ENGINEER' };
}

function inIds(list: { in: string[] } | string | undefined, value: string): boolean {
  return (
    list === undefined || (typeof list === 'string' ? list === value : list.in.includes(value))
  );
}

function db(): PermissionsDb {
  const teamById = new Map(world.teams.map((t) => [t.id, t]));
  const api = {
    organizationMembership: {
      findMany: async (args: { where: { userId: string; orgId?: { in: string[] } } }) =>
        world.orgMemberships.filter(
          (m) => m.userId === args.where.userId && inIds(args.where.orgId, m.orgId)
        ),
    },
    team: {
      findMany: async (args: {
        where: { id?: { in: string[] }; orgId?: { in: string[] }; isActive?: boolean };
      }) =>
        world.teams.filter(
          (t) =>
            inIds(args.where.id, t.id) &&
            inIds(args.where.orgId, t.orgId) &&
            (args.where.isActive === undefined || t.isActive === args.where.isActive)
        ),
    },
    teamMembership: {
      findMany: async (args: { where: { userId: string; teamId?: { in: string[] } } }) =>
        world.teamMemberships
          .filter((m) => m.userId === args.where.userId && inIds(args.where.teamId, m.teamId))
          .map((m) => ({ ...m, team: teamById.get(m.teamId) })),
    },
  };
  return api as unknown as PermissionsDb;
}

const keys = Object.keys(CATALOG) as CapabilityKey[];

describe('can() and heldScope() agree', () => {
  for (const key of keys) {
    const def = CATALOG[key] as { scope: string };
    it(key, async () => {
      const prisma = db();
      for (const person of people) {
        const actor = actorOf(person);
        const held = await heldScope(prisma, actor, key);
        const label = `${key} as ${person}`;

        if (def.scope === 'team') {
          for (const t of world.teams) {
            const d = await can(prisma, actor, key, { teamId: t.id });
            expect(d.allowed, `${label} on ${t.id}`).toBe(held.all || held.teamIds.includes(t.id));
          }
          expect(held.orgIds, `${label} orgIds`).toEqual([]);
        }
        if (def.scope === 'org') {
          for (const orgId of ['A', 'B']) {
            const d = await can(prisma, actor, key, { orgId });
            expect(d.allowed, `${label} on org ${orgId}`).toBe(
              held.all || held.orgIds.includes(orgId)
            );
          }
        }
        const any = await can(prisma, actor, key, { anyTeam: true });
        const expected =
          def.scope === 'org'
            ? held.all || held.orgIds.length > 0
            : held.all || held.teamIds.length > 0;
        expect(any.allowed, `${label} anyTeam`).toBe(expected);
      }
    });
  }
});
