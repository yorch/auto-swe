import type { PrismaClient } from '@auto-swe/shared';
import { describe, expect, it, vi } from 'vitest';
import { enrollDefaultTeam } from './defaultTeamMembership.js';

function database(existing = false, failAudit = false) {
  const state = {
    audits: [] as Array<{ actorId: string | null; entityType: string }>,
    org: existing
      ? { id: 'org-member', role: 'ORG_ADMIN' }
      : (null as { id: string; role: string } | null),
    team: existing
      ? { id: 'team-member', role: 'ADMIN' }
      : (null as { id: string; role: string } | null),
  };
  const tx = {
    configAuditLog: {
      create: async ({ data }: { data: { actorId: string | null; entityType: string } }) => {
        if (failAudit) {
          throw new Error('audit failed');
        }
        state.audits.push(data);
      },
    },
    organizationMembership: {
      createMany: vi.fn(async () => {
        if (state.org) {
          return { count: 0 };
        }
        state.org = { id: 'org-member', role: 'ORG_MEMBER' };
        return { count: 1 };
      }),
      findUniqueOrThrow: async () => state.org,
    },
    teamMembership: {
      createMany: vi.fn(async () => {
        if (state.team) {
          return { count: 0 };
        }
        state.team = { id: 'team-member', role: 'ENGINEER' };
        return { count: 1 };
      }),
      findUniqueOrThrow: async () => state.team,
    },
  };
  const db = {
    $transaction: async (write: (client: typeof tx) => Promise<void>) => {
      const before = structuredClone(state);
      try {
        await write(tx);
      } catch (err) {
        Object.assign(state, before);
        throw err;
      }
    },
  } as unknown as PrismaClient;
  return { db, state, tx };
}

describe('default-team enrollment transaction', () => {
  it.each([null, 'platform-admin'])(
    'creates both memberships with actor %s and is idempotent',
    async (actorId) => {
      const { db, state, tx } = database();
      await enrollDefaultTeam(db, { id: 'team', orgId: 'org' }, 'user', actorId);
      await enrollDefaultTeam(db, { id: 'team', orgId: 'org' }, 'user', actorId);
      expect(tx.organizationMembership.createMany).toHaveBeenCalledWith({
        data: { orgId: 'org', role: 'ORG_MEMBER', userId: 'user' },
        skipDuplicates: true,
      });
      expect(tx.teamMembership.createMany).toHaveBeenCalledWith({
        data: { role: 'ENGINEER', teamId: 'team', userId: 'user' },
        skipDuplicates: true,
      });
      expect(state.audits).toEqual([
        expect.objectContaining({ actorId, entityType: 'OrganizationMembership' }),
        expect.objectContaining({ actorId, entityType: 'TeamMembership' }),
      ]);
    }
  );

  it('does not downgrade or audit existing roles', async () => {
    const { db, state } = database(true);
    await enrollDefaultTeam(db, { id: 'team', orgId: 'org' }, 'user', null);
    expect(state.org?.role).toBe('ORG_ADMIN');
    expect(state.team?.role).toBe('ADMIN');
    expect(state.audits).toEqual([]);
  });

  it('rolls back enrollment on audit failure', async () => {
    const { db, state } = database(false, true);
    await expect(enrollDefaultTeam(db, { id: 'team', orgId: 'org' }, 'user', null)).rejects.toThrow(
      'audit failed'
    );
    expect(state).toEqual({ audits: [], org: null, team: null });
  });
});
