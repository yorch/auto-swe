import { describe, expect, it } from 'vitest';
import { canAuthorTeamCode, canWriteTeamResource, teamPermissions } from './teamPermissions';

describe('teamPermissions', () => {
  it('lets a platform ADMIN do everything, whatever their team role', () => {
    expect(teamPermissions('ADMIN', undefined)).toEqual({
      canEditAllowlists: true,
      canManageCallbacks: true,
      canManageMembers: true,
      canManageTeamAgents: true,
      canManageTeamSecrets: true,
      grantableRoles: ['ENGINEER', 'LEAD', 'ADMIN'],
    });
  });

  it('lets a team ADMIN manage team secrets, and not a team LEAD or a platform LEAD', () => {
    expect(teamPermissions('ENGINEER', 'ADMIN').canManageTeamSecrets).toBe(true);
    expect(teamPermissions('LEAD', 'LEAD').canManageTeamSecrets).toBe(false);
    expect(teamPermissions('ADMIN', undefined).canManageTeamSecrets).toBe(true);
  });

  it('lets a team LEAD manage run-callback endpoints, and not a team ENGINEER', () => {
    expect(teamPermissions('ENGINEER', 'LEAD').canManageCallbacks).toBe(true);
    expect(teamPermissions('LEAD', 'ENGINEER').canManageCallbacks).toBe(false);
    expect(teamPermissions('ENGINEER', undefined).canManageCallbacks).toBe(false);
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

  it('lets a platform ENGINEER who leads the team manage members: the team role alone decides', () => {
    const p = teamPermissions('ENGINEER', 'LEAD');
    expect(p.canManageMembers).toBe(true);
    expect(p.grantableRoles).toEqual(['ENGINEER', 'LEAD']);
  });

  it('keeps a platform ENGINEER who is only a team ENGINEER out of member ops', () => {
    const p = teamPermissions('ENGINEER', 'ENGINEER');
    expect(p.canManageMembers).toBe(false);
    expect(p.grantableRoles).toEqual([]);
  });

  it('lets a platform ENGINEER who is team ADMIN manage team agents and members, not allowlists', () => {
    const p = teamPermissions('ENGINEER', 'ADMIN');
    expect(p.canManageTeamAgents).toBe(true);
    expect(p.canManageMembers).toBe(true);
    expect(p.grantableRoles).toEqual(['ENGINEER', 'LEAD', 'ADMIN']);
    expect(p.canEditAllowlists).toBe(false);
  });
});

describe('canWriteTeamResource', () => {
  const led = new Set(['team-a']);

  it('lets a platform ADMIN write anything, GLOBAL rows included', () => {
    expect(canWriteTeamResource('ADMIN', null, null)).toBe(true);
    expect(canWriteTeamResource('ADMIN', 'team-z', new Set())).toBe(true);
  });

  it('follows the owning team alone, whatever the platform role', () => {
    expect(canWriteTeamResource('LEAD', 'team-a', led)).toBe(true);
    expect(canWriteTeamResource('LEAD', 'team-b', led)).toBe(false);
    expect(canWriteTeamResource('ENGINEER', 'team-a', led)).toBe(true);
    expect(canWriteTeamResource('ENGINEER', 'team-b', led)).toBe(false);
  });

  it('refuses a GLOBAL (team-less) resource to a non-ADMIN', () => {
    expect(canWriteTeamResource('LEAD', null, led)).toBe(false);
  });

  it('answers false while the led teams load', () => {
    expect(canWriteTeamResource('ENGINEER', 'team-a', null)).toBe(false);
    expect(canWriteTeamResource('LEAD', 'team-a', null)).toBe(false);
  });
});

describe('canAuthorTeamCode', () => {
  const admin = new Set(['team-a']);

  it('lets a team ADMIN author code whatever their platform role', () => {
    expect(canAuthorTeamCode('ENGINEER', 'team-a', admin)).toBe(true);
    expect(canAuthorTeamCode('LEAD', 'team-a', admin)).toBe(true);
  });

  it('refuses a team the caller does not administer, a GLOBAL resource and a loading list', () => {
    expect(canAuthorTeamCode('LEAD', 'team-b', admin)).toBe(false);
    expect(canAuthorTeamCode('LEAD', null, admin)).toBe(false);
    expect(canAuthorTeamCode('ENGINEER', 'team-a', null)).toBe(false);
  });

  it('lets a platform ADMIN author anything', () => {
    expect(canAuthorTeamCode('ADMIN', null, null)).toBe(true);
  });
});

describe('repository management reasons', () => {
  it('canManageTeamRepos follows the owning team, platform ADMIN bypassing', async () => {
    const { canManageTeamRepos, repoManageReason, runControlReason } = await import(
      './teamPermissions'
    );
    expect(canManageTeamRepos('LEAD', 't1', new Set(['t1']))).toBe(true);
    expect(canManageTeamRepos('LEAD', 't2', new Set(['t1']))).toBe(false);
    expect(canManageTeamRepos('ADMIN', 't2', new Set())).toBe(true);
    expect(repoManageReason('Design', 'edit')).toBe(
      'Only leads of Design or an administrator can edit this repository.'
    );
    expect(runControlReason('Design', 'cancel')).toBe(
      'Only members of Design or the launcher can cancel this run.'
    );
  });
});
