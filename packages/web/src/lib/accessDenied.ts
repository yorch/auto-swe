import type { Role } from '@auto-swe/shared';
import { roleMeets } from '@auto-swe/shared/config/permissions';
import { pageTitle } from '@/lib/navigation';
import { isRole } from '@/lib/roles';

/**
 * A signed-in user who opens a page above their role is sent Home with
 * `?denied=<path>&need=<ROLE>`, and Home says why — rather than bouncing
 * them with no explanation.
 */
export function deniedHref(path: string, allowed: Role[]): string {
  const params = new URLSearchParams({ denied: path });
  // The lowest role the page admits is the one the user needs.
  const lowest = allowed.find((r) => allowed.every((o) => roleMeets(o, r)));
  if (lowest) {
    params.set('need', lowest);
  }
  return `/?${params.toString()}`;
}

const ROLE_NAMES: Record<Role, string> = {
  ADMIN: 'administrator',
  ENGINEER: 'engineer',
  LEAD: 'team lead',
};

/** The notice Home shows, or null when the query carries no (valid) denial. */
export function deniedMessage(denied: string | null, need: string | null): string | null {
  // Only same-origin paths: this text is shown to the user, and the value is attacker-controllable.
  if (!denied?.startsWith('/') || denied.startsWith('//')) {
    return null;
  }
  const page = pageTitle(denied.split('?')[0]);
  const role = isRole(need) ? `the ${ROLE_NAMES[need]} role` : 'more access';
  return `You need ${role} to open ${page}. Ask an administrator if you think you should have access.`;
}
