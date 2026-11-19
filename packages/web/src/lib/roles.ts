import type { Role } from '@auto-swe/shared';

/**
 * The dashboard's one role check, ranked ADMIN > LEAD > ENGINEER. It is an interim home: the
 * gateway no longer ranks platform roles, and the dashboard moves to the server's effective
 * permissions (`GET /api/v1/me/permissions`) in the rename step.
 *
 * An unknown or missing role never meets anything: a user whose role the
 * client could not read is treated as unprivileged, not as an ENGINEER.
 */
const KNOWN_ROLES: ReadonlySet<string> = new Set<Role>(['ENGINEER', 'LEAD', 'ADMIN']);

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && KNOWN_ROLES.has(value);
}

const RANK: Record<Role, number> = { ADMIN: 3, ENGINEER: 1, LEAD: 2 };

export function roleMeets(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}

export function hasRole(actual: string | null | undefined, required: Role): boolean {
  return isRole(actual) && roleMeets(actual, required);
}
