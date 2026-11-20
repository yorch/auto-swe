import { describe, expect, it } from 'vitest';
import {
  orgRoleLabel,
  orgRoleRank,
  platformRoleConsequence,
  platformRoleLabel,
  TEAM_ROLE_OPTIONS,
  teamRoleLabel,
  teamRoleRank,
  writeAccessLabel,
} from './roleLabels';

describe('role labels', () => {
  it('names the three levels apart', () => {
    expect(platformRoleLabel('ADMIN')).toBe('Platform admin');
    expect(platformRoleLabel('USER')).toBe('User');
    expect(teamRoleLabel('ADMIN')).toBe('Team admin');
    expect(teamRoleLabel('LEAD')).toBe('Team lead');
    expect(teamRoleLabel('MEMBER')).toBe('Team member');
    expect(orgRoleLabel('ADMIN')).toBe('Org admin');
    expect(orgRoleLabel('MEMBER')).toBe('Org member');
  });

  it('passes an unknown or historical value through, and nothing for a missing one', () => {
    expect(teamRoleLabel('ENGINEER')).toBe('ENGINEER');
    expect(orgRoleLabel('ORG_ADMIN')).toBe('ORG_ADMIN');
    expect(platformRoleLabel(undefined)).toBe('');
    expect(teamRoleLabel(null)).toBe('');
  });

  it('lists the team roles lowest first', () => {
    expect(TEAM_ROLE_OPTIONS.map((o) => o.value)).toEqual(['MEMBER', 'LEAD', 'ADMIN']);
    expect(teamRoleRank('LEAD')).toBeGreaterThan(teamRoleRank('MEMBER'));
    expect(teamRoleRank('ADMIN')).toBeGreaterThan(teamRoleRank('LEAD'));
    expect(teamRoleRank('ENGINEER')).toBe(-1);
    expect(orgRoleRank('ADMIN')).toBeGreaterThan(orgRoleRank('MEMBER'));
  });

  it('words who may write a setting', () => {
    expect(writeAccessLabel('admin')).toBe('platform admin');
    expect(writeAccessLabel('grantable')).toBe('platform admin or a grant');
  });

  it('describes a platform role change, with a fallback for an unknown role', () => {
    expect(platformRoleConsequence('ADMIN').dangerous).toBe(true);
    expect(platformRoleConsequence('USER').dangerous).toBe(false);
    expect(platformRoleConsequence('LEAD').effect).toBeTruthy();
  });
});
