import { describe, expect, it } from 'vitest';
import {
  canSeeTeamManage,
  canSeeTeamSettings,
  TEAM_TABS,
  teamHref,
  teamSettingsScope,
  teamTabFromPath,
} from './teamSpace';

describe('teamSettingsScope', () => {
  it('gives a platform ADMIN every section', () => {
    expect(teamSettingsScope('ADMIN', null, false)).toBe('full');
  });
  it('gives a team ADMIN or LEAD every section', () => {
    expect(teamSettingsScope('ENGINEER', 'ADMIN', false)).toBe('full');
    expect(teamSettingsScope('ENGINEER', 'LEAD', false)).toBe('full');
  });
  it('gives an ORG_ADMIN below team LEAD the Budget section alone', () => {
    expect(teamSettingsScope('ENGINEER', 'ENGINEER', true)).toBe('budget');
    expect(teamSettingsScope('LEAD', null, true)).toBe('budget');
  });
  it('gives an ORG_ADMIN who leads the team the full set', () => {
    expect(teamSettingsScope('ENGINEER', 'LEAD', true)).toBe('full');
  });
  it('gives an engineer no Settings, whatever the platform role', () => {
    expect(teamSettingsScope('ENGINEER', 'ENGINEER', false)).toBeNull();
    expect(teamSettingsScope('LEAD', 'ENGINEER', false)).toBeNull();
    expect(canSeeTeamSettings('LEAD', 'ENGINEER')).toBe(false);
    expect(canSeeTeamSettings('LEAD', 'ENGINEER', true)).toBe(true);
  });
});

describe('the Manage tab', () => {
  it('sits before Settings, at /manage', () => {
    const ids = TEAM_TABS.map((t) => t.id);
    expect(ids.indexOf('manage')).toBe(ids.indexOf('settings') - 1);
    expect(teamHref('payments', 'manage')).toBe('/teams/payments/manage');
    expect(teamTabFromPath('/teams/payments/manage')).toBe('manage');
  });
  it('is offered to a team LEAD or ADMIN', () => {
    expect(canSeeTeamManage('ENGINEER', 'LEAD')).toBe(true);
    expect(canSeeTeamManage('ENGINEER', 'ADMIN')).toBe(true);
  });
  it('is offered to a platform ADMIN who is not a member', () => {
    expect(canSeeTeamManage('ADMIN', null)).toBe(true);
  });
  it('is not offered to an engineer, even a platform LEAD, or a non-member', () => {
    expect(canSeeTeamManage('ENGINEER', 'ENGINEER')).toBe(false);
    expect(canSeeTeamManage('LEAD', 'ENGINEER')).toBe(false);
    expect(canSeeTeamManage('LEAD', null)).toBe(false);
  });
});
