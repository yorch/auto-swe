import { describe, expect, it } from 'vitest';
import {
  isPlatformAdmin,
  orgIsAdmin,
  orgRankMeets,
  orgRankOf,
  TEAM_ROLE_RANK,
  teamRankMeets,
  teamRankOf,
} from './standing.js';

describe('standing', () => {
  it('maps stored team roles to ranks, old and new spellings alike, and unknowns to null', () => {
    expect(teamRankOf('ADMIN')).toBe('ADMIN');
    expect(teamRankOf('LEAD')).toBe('LEAD');
    expect(teamRankOf('ENGINEER')).toBe('MEMBER');
    expect(teamRankOf('MEMBER')).toBe('MEMBER');
    expect(teamRankOf('OWNER')).toBeNull();
    expect(teamRankOf(null)).toBeNull();
  });
  it('maps stored org roles to ranks', () => {
    expect(orgRankOf('ORG_ADMIN')).toBe('ADMIN');
    expect(orgRankOf('ADMIN')).toBe('ADMIN');
    expect(orgRankOf('ORG_MEMBER')).toBe('MEMBER');
    expect(orgRankOf('nope')).toBeNull();
    expect(orgIsAdmin('ORG_ADMIN')).toBe(true);
    expect(orgIsAdmin('ORG_MEMBER')).toBe(false);
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
  it('knows platform admin, and a principal is never one', () => {
    expect(isPlatformAdmin({ role: 'ADMIN' })).toBe(true);
    expect(isPlatformAdmin({ role: 'USER' })).toBe(false);
    expect(isPlatformAdmin({ kind: 'principal', role: 'ADMIN' })).toBe(false);
  });
});
