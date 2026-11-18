import type { PrismaClient } from '@auto-swe/shared';
import { describe, expect, it } from 'vitest';
import { loadLaunchTrackerContexts } from './trackerLaunchContexts.js';

const prismaWith = (rows: {
  teams?: Array<{ teamId: string; team: { orgId: string | null } }>;
  orgs?: Array<{ orgId: string }>;
  principalTeam?: unknown;
}) =>
  ({
    organizationMembership: { findMany: async () => rows.orgs ?? [] },
    team: { findUnique: async () => rows.principalTeam ?? null },
    teamMembership: { findMany: async () => rows.teams ?? [] },
  }) as unknown as PrismaClient;

const user = { kind: 'user', userId: 'u1' } as const;

describe('loadLaunchTrackerContexts', () => {
  it('lists each active team with its organization', async () => {
    const prisma = prismaWith({ teams: [{ team: { orgId: 'o1' }, teamId: 't1' }] });
    expect(await loadLaunchTrackerContexts(prisma, user)).toEqual([{ orgId: 'o1', teamId: 't1' }]);
  });

  it('adds an organization no listed team belongs to, once', async () => {
    const prisma = prismaWith({
      orgs: [{ orgId: 'o1' }, { orgId: 'o2' }],
      teams: [{ team: { orgId: 'o1' }, teamId: 't1' }],
    });
    expect(await loadLaunchTrackerContexts(prisma, user)).toEqual([
      { orgId: 'o1', teamId: 't1' },
      { orgId: 'o2' },
    ]);
  });

  it('is empty for a person with no team and no organization', async () => {
    expect(await loadLaunchTrackerContexts(prismaWith({}), user)).toEqual([]);
  });

  it("is a service principal's own team when it and its organization are active", async () => {
    const principalTeam = {
      id: 'sp-team',
      isActive: true,
      organization: { isActive: true },
      orgId: 'o1',
    };
    expect(
      await loadLaunchTrackerContexts(prismaWith({ principalTeam }), {
        kind: 'service',
        teamId: 'sp-team',
      })
    ).toEqual([{ orgId: 'o1', teamId: 'sp-team' }]);
  });

  it('is empty for a service principal whose team or organization is inactive', async () => {
    for (const principalTeam of [
      { id: 'sp-team', isActive: false, organization: { isActive: true }, orgId: 'o1' },
      { id: 'sp-team', isActive: true, organization: { isActive: false }, orgId: 'o1' },
      { id: 'sp-team', isActive: true, organization: null, orgId: null },
      null,
    ]) {
      expect(
        await loadLaunchTrackerContexts(prismaWith({ principalTeam }), {
          kind: 'service',
          teamId: 'sp-team',
        })
      ).toEqual([]);
    }
  });
});
