import { describe, expect, it, vi } from 'vitest';
import { skillVisibilityWhere, updateSkill } from './skillLibraryService.js';

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

describe('updateSkill provenance', () => {
  const existing = {
    currentRevision: 3,
    description: null,
    id: 's1',
    isBuiltIn: false,
    promptText: 'typed by hand',
    sourcePath: null,
  };

  it('writes the provenance a restore passes onto the new revision', async () => {
    const update = vi.fn().mockResolvedValue({ currentRevision: 4 });
    const prisma = { skill: { update } };
    await updateSkill(prisma as never, existing as never, { promptText: 'imported text' }, 'u1', {
      referenceFiles: [{ content: 'c', path: 'a.md' }],
      sourcePath: 'p/SKILL.md',
      sourceSha: 'abc',
    });
    const rev = update.mock.calls[0][0].data.revisions.create;
    expect(rev).toMatchObject({ revision: 4, sourcePath: 'p/SKILL.md', sourceSha: 'abc' });
    expect(rev.referenceFiles).toEqual([{ content: 'c', path: 'a.md' }]);
  });

  it('writes none when the restored revision was not imported', async () => {
    const update = vi.fn().mockResolvedValue({ currentRevision: 4 });
    await updateSkill(
      { skill: { update } } as never,
      existing as never,
      { promptText: 'x' },
      'u1',
      {}
    );
    expect(update.mock.calls[0][0].data.revisions.create).toMatchObject({
      sourcePath: null,
      sourceSha: null,
    });
  });
});
