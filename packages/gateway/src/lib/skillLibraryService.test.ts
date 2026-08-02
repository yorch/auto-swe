import { describe, expect, it } from 'vitest';
import { skillVisibilityWhere } from './skillLibraryService.js';

/**
 * `skills` previously carried no tenant column, so the team-scoped list
 * returned every custom skill's `promptText` to any team member. This filter is
 * what closes that; the DB CHECK (`skills_scope_keys_check`) backs it by making
 * a GLOBAL row with a team_id — which would leak into a tenant's view —
 * unrepresentable.
 */
describe('skillVisibilityWhere', () => {
  it('includes GLOBAL and the caller team, and omits ORGANIZATION when the team has no org', () => {
    expect(skillVisibilityWhere({ teamId: 'team-1' })).toEqual({
      OR: [{ scope: 'GLOBAL' }, { scope: 'TEAM', teamId: 'team-1' }],
    });
  });

  it('adds the org branch when the team belongs to one', () => {
    expect(skillVisibilityWhere({ orgId: 'org-1', teamId: 'team-1' })).toEqual({
      OR: [
        { scope: 'GLOBAL' },
        { scope: 'TEAM', teamId: 'team-1' },
        { orgId: 'org-1', scope: 'ORGANIZATION' },
      ],
    });
  });

  it('never matches another tenant', () => {
    const where = skillVisibilityWhere({ orgId: 'org-1', teamId: 'team-1' });
    const branches = JSON.stringify(where);
    expect(branches).not.toContain('team-2');
    expect(branches).not.toContain('org-2');
    // Every non-GLOBAL branch is pinned to a specific tenant id — a branch that
    // matched on scope alone would re-open the leak.
    for (const branch of where.OR) {
      if (branch.scope !== 'GLOBAL') {
        expect(Object.keys(branch).length).toBeGreaterThan(1);
      }
    }
  });
});
