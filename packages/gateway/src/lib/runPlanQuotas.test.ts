import { describe, expect, it } from 'vitest';
import { limitScopes, MAX_LIMIT_SCOPES } from './runPlanQuotas.js';

const reader = (teams: Array<{ id: string; orgId: string }>, orgs: Array<{ orgId: string }> = []) =>
  ({
    organizationMembership: { findMany: async () => orgs },
    teamMembership: { findMany: async () => teams.map((team) => ({ team })) },
  }) as never;

describe('limitScopes', () => {
  it('puts the repository’s scope first, then teams, then organizations, without repeats', async () => {
    const scopes = await limitScopes(
      reader(
        [
          { id: 'team-1', orgId: 'org-1' },
          { id: 'team-2', orgId: 'org-1' },
        ],
        [{ orgId: 'org-1' }, { orgId: 'org-9' }]
      ),
      'user-1',
      { orgId: 'org-1', teamId: 'team-1' }
    );
    expect(scopes).toEqual([
      { orgId: 'org-1', teamId: 'team-1' },
      { orgId: 'org-1', teamId: 'team-2' },
      { orgId: 'org-9', teamId: null },
    ]);
  });

  it('keeps the repository’s scope even when the person is not a member of its team', async () => {
    const scopes = await limitScopes(reader([]), 'user-1', { orgId: 'org-1', teamId: 'team-x' });
    expect(scopes).toEqual([{ orgId: 'org-1', teamId: 'team-x' }]);
  });

  it('considers at most 50 scopes', async () => {
    const teams = Array.from({ length: 80 }, (_, i) => ({
      id: `team-${String(i).padStart(3, '0')}`,
      orgId: 'org-1',
    }));
    const scopes = await limitScopes(reader(teams), 'user-1', { orgId: 'org-1', teamId: 'team-x' });
    expect(scopes).toHaveLength(MAX_LIMIT_SCOPES);
    expect(scopes[0]).toEqual({ orgId: 'org-1', teamId: 'team-x' });
    expect(scopes[1]?.teamId).toBe('team-000');
  });
});
