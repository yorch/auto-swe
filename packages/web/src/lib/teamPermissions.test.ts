import { describe, expect, it } from 'vitest';
import { canWriteTeamResource, teamPermissions } from './teamPermissions';

describe('teamPermissions', () => {
  it('lets a platform ADMIN do everything, whatever their team role', () => {
    expect(teamPermissions('ADMIN', undefined)).toEqual({
      canEditAllowlists: true,
      canManageMembers: true,
      canManageTeamAgents: true,
      grantableRoles: ['ENGINEER', 'LEAD', 'ADMIN'],
    });
  });

  it('does not let a platform LEAD manage a team they do not lead', () => {
    const p = teamPermissions('LEAD', 'ENGINEER');
    expect(p.canManageMembers).toBe(false);
    expect(p.grantableRoles).toEqual([]);
    expect(teamPermissions('LEAD', undefined).canManageMembers).toBe(false);
  });

  it('lets a platform LEAD who leads the team grant up to LEAD, not ADMIN', () => {
    const p = teamPermissions('LEAD', 'LEAD');
    expect(p.canManageMembers).toBe(true);
    expect(p.grantableRoles).toEqual(['ENGINEER', 'LEAD']);
    expect(p.canEditAllowlists).toBe(false);
    expect(p.canManageTeamAgents).toBe(false);
  });

  it('lets a team ADMIN who is a platform LEAD grant ADMIN and manage team agents', () => {
    const p = teamPermissions('LEAD', 'ADMIN');
    expect(p.grantableRoles).toEqual(['ENGINEER', 'LEAD', 'ADMIN']);
    expect(p.canManageTeamAgents).toBe(true);
    expect(p.canEditAllowlists).toBe(false);
  });

  it('keeps a platform ENGINEER out of member ops even as team LEAD', () => {
    const p = teamPermissions('ENGINEER', 'LEAD');
    expect(p.canManageMembers).toBe(false);
    expect(p.grantableRoles).toEqual([]);
  });

  it('lets a platform ENGINEER who is team ADMIN manage team agents only', () => {
    const p = teamPermissions('ENGINEER', 'ADMIN');
    expect(p.canManageTeamAgents).toBe(true);
    expect(p.canManageMembers).toBe(false);
    expect(p.canEditAllowlists).toBe(false);
  });
});

describe('canWriteTeamResource', () => {
  const led = new Set(['team-a']);

  it('lets a platform ADMIN write anything, GLOBAL rows included', () => {
    expect(canWriteTeamResource('ADMIN', null, null)).toBe(true);
    expect(canWriteTeamResource('ADMIN', 'team-z', new Set())).toBe(true);
  });

  it('requires a platform LEAD to also lead the owning team', () => {
    expect(canWriteTeamResource('LEAD', 'team-a', led)).toBe(true);
    expect(canWriteTeamResource('LEAD', 'team-b', led)).toBe(false);
  });

  it('refuses a GLOBAL (team-less) resource to a non-ADMIN', () => {
    expect(canWriteTeamResource('LEAD', null, led)).toBe(false);
  });

  it('refuses an ENGINEER even on a team they lead, and answers false while loading', () => {
    expect(canWriteTeamResource('ENGINEER', 'team-a', led)).toBe(false);
    expect(canWriteTeamResource('LEAD', 'team-a', null)).toBe(false);
  });
});
