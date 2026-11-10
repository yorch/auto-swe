import { describe, expect, it } from 'vitest';
import { canSeeTeamSettings, teamSettingsScope } from './teamSpace';

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
