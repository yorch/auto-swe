import type { Role } from '@auto-swe/shared';
import { roleMeets } from '@auto-swe/shared/config/permissions';

/**
 * The dashboard's one role check. It defers to the shared `roleMeets` — the
 * same seniority order the gateway's `requireAuth({ requiredRole })` applies —
 * so a control hidden here is hidden exactly when the API would refuse it.
 *
 * An unknown or missing role never meets anything: a user whose role the
 * client could not read is treated as unprivileged, not as an ENGINEER.
 */
const KNOWN_ROLES: ReadonlySet<string> = new Set<Role>(['ENGINEER', 'LEAD', 'ADMIN']);

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && KNOWN_ROLES.has(value);
}

export function hasRole(actual: string | null | undefined, required: Role): boolean {
  return isRole(actual) && roleMeets(actual, required);
}

/** Tooltip for a control shown disabled because the caller's role is too low. */
export function requiresRoleTitle(required: Role): string {
  return `Requires the ${required} role`;
}
