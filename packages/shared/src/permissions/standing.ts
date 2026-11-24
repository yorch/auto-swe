import { ORG_ROLES, type OrgRoleValue, TEAM_ROLES, type TeamRoleValue } from './roles.js';
import type { OrgRank, TeamRank } from './types.js';

/**
 * The only module that reads stored role values. Everything else works in `TeamRank`/`OrgRank`
 * and booleans, so renaming the stored enums edits this file alone.
 *
 * Only the current spellings are recognised. Every reader of these functions is fed a membership
 * row read from the database in the same request or activity, where the enums hold nothing else;
 * no authorization decision reads a role string persisted in a workflow input or Temporal history
 * (the launch actor is used for its `sub`, and the role is re-read from the database).
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
    case 'MEMBER':
      return 'MEMBER';
    default:
      return null;
  }
}

/** A stored organization-membership role as a rank, or `null` for an unknown role. */
export function orgRankOf(role: string | null | undefined): OrgRank | null {
  switch (role) {
    case 'ADMIN':
      return 'ADMIN';
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

/**
 * The stored team-membership roles at or above `minimum`, for a Prisma `role: { in: … }` filter.
 * A filter that must say "leads and above" asks here instead of spelling role literals, so a
 * renamed or added role edits this module alone.
 */
export function teamRolesAtLeast(minimum: TeamRank): TeamRoleValue[] {
  return TEAM_ROLES.filter((role) => TEAM_ROLE_RANK[role] >= TEAM_ROLE_RANK[minimum]);
}

/** The stored organization-membership roles at or above `minimum`, for a `role: { in: … }` filter. */
export function orgRolesAtLeast(minimum: OrgRank): OrgRoleValue[] {
  return ORG_ROLES.filter((role) => ORG_ROLE_RANK[role] >= ORG_ROLE_RANK[minimum]);
}
