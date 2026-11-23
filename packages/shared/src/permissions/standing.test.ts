import { describe, expect, it } from 'vitest';
import {
  isPlatformAdmin,
  isPlatformAdminRole,
  orgIsAdmin,
  orgRankMeets,
  orgRankOf,
  orgRolesAtLeast,
  TEAM_ROLE_RANK,
  teamRankMeets,
  teamRankOf,
  teamRolesAtLeast,
} from './standing.js';

describe('standing', () => {
  it('maps stored team roles to ranks and unknowns to null', () => {
    expect(teamRankOf('ADMIN')).toBe('ADMIN');
    expect(teamRankOf('LEAD')).toBe('LEAD');
    expect(teamRankOf('MEMBER')).toBe('MEMBER');
    expect(teamRankOf('OWNER')).toBeNull();
    expect(teamRankOf(null)).toBeNull();
  });
  it('maps stored org roles to ranks', () => {
    expect(orgRankOf('ADMIN')).toBe('ADMIN');
    expect(orgRankOf('nope')).toBeNull();
    expect(orgIsAdmin('ADMIN')).toBe(true);
    expect(orgIsAdmin('MEMBER')).toBe(false);
  });
  it('resolves every retired spelling to no standing, never a privileged one', () => {
    for (const retired of ['ENGINEER', 'ORG_ADMIN', 'ORG_MEMBER', 'OWNER', 'admin', '']) {
      expect(teamRankOf(retired)).toBeNull();
      expect(orgRankOf(retired)).toBeNull();
      expect(orgIsAdmin(retired)).toBe(false);
      expect(isPlatformAdminRole(retired)).toBe(false);
      expect(teamRankMeets(teamRankOf(retired), 'MEMBER')).toBe(false);
      expect(orgRankMeets(orgRankOf(retired), 'MEMBER')).toBe(false);
    }
  });
  it('ranks MEMBER < LEAD < ADMIN', () => {
    expect(TEAM_ROLE_RANK.MEMBER).toBeLessThan(TEAM_ROLE_RANK.LEAD);
    expect(TEAM_ROLE_RANK.LEAD).toBeLessThan(TEAM_ROLE_RANK.ADMIN);
    expect(teamRankMeets('LEAD', 'MEMBER')).toBe(true);
    expect(teamRankMeets('MEMBER', 'LEAD')).toBe(false);
    expect(teamRankMeets(null, 'MEMBER')).toBe(false);
    expect(orgRankMeets('ADMIN', 'MEMBER')).toBe(true);
    expect(orgRankMeets('MEMBER', 'ADMIN')).toBe(false);
    expect(orgRankMeets(null, 'MEMBER')).toBe(false);
  });
  it('lists the stored roles at or above a rank', () => {
    expect(teamRolesAtLeast('LEAD').sort()).toEqual(['ADMIN', 'LEAD']);
    expect(teamRolesAtLeast('ADMIN')).toEqual(['ADMIN']);
    expect(teamRolesAtLeast('MEMBER')).toHaveLength(3);
    expect(orgRolesAtLeast('ADMIN')).toEqual(['ADMIN']);
    expect(orgRolesAtLeast('MEMBER')).toHaveLength(2);
  });
  it('knows platform admin, and a principal is never one', () => {
    expect(isPlatformAdmin({ role: 'ADMIN' })).toBe(true);
    expect(isPlatformAdmin({ role: 'USER' })).toBe(false);
    expect(isPlatformAdmin({ kind: 'principal', role: 'ADMIN' })).toBe(false);
  });
});
