import type { OrgRank, TeamRank } from './types.js';

/**
 * The only module that reads stored role values. Everything else works in `TeamRank`/`OrgRank` and
 * booleans, so renaming the stored enums edits this file alone.
 *
 * Unknown values map to `null`/`false`: a role this module has never heard of confers nothing.
 */

/** Seniority, lowest first. Used for the member-change hierarchy guard and capability minimums. */
export const TEAM_ROLE_RANK: Readonly<Record<TeamRank, number>> = {
  ADMIN: 3,
  LEAD: 2,
  MEMBER: 1,
};

const ORG_ROLE_RANK: Readonly<Record<OrgRank, number>> = { ADMIN: 2, MEMBER: 1 };

/** Whether a stored platform role is the instance operator's. */
export function isPlatformAdminRole(role: string | null | undefined): boolean {
  return role === 'ADMIN';
}

/** Whether `actor` is a person holding platform `ADMIN`. A service principal never is. */
export function isPlatformAdmin(actor: { kind?: string; role?: string | null }): boolean {
  return actor.kind !== 'principal' && isPlatformAdminRole(actor.role);
}

/** A stored team-membership role as a rank, or `null` for a role this module does not know. */
export function teamRankOf(role: string | null | undefined): TeamRank | null {
  switch (role) {
    case 'ADMIN':
      return 'ADMIN';
    case 'LEAD':
      return 'LEAD';
    case 'ENGINEER':
    case 'MEMBER':
      return 'MEMBER';
    default:
      return null;
  }
}

/** A stored organization-membership role as a rank, or `null` for an unknown role. */
export function orgRankOf(role: string | null | undefined): OrgRank | null {
  switch (role) {
    case 'ORG_ADMIN':
    case 'ADMIN':
      return 'ADMIN';
    case 'ORG_MEMBER':
    case 'MEMBER':
      return 'MEMBER';
    default:
      return null;
  }
}

/** Whether a stored organization role is an organization administrator's. */
export function orgIsAdmin(role: string | null | undefined): boolean {
  return orgRankOf(role) === 'ADMIN';
}

/** `actual` is at least `required`. A non-member (`null`) meets nothing. */
export function teamRankMeets(actual: TeamRank | null, required: TeamRank): boolean {
  return actual !== null && TEAM_ROLE_RANK[actual] >= TEAM_ROLE_RANK[required];
}

/** `actual` is at least `required`. A non-member (`null`) meets nothing. */
export function orgRankMeets(actual: OrgRank | null, required: OrgRank): boolean {
  return actual !== null && ORG_ROLE_RANK[actual] >= ORG_ROLE_RANK[required];
}
