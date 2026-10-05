import type { Role } from '@auto-swe/shared';
import { roleMeets } from '@auto-swe/shared/config/permissions';
import { knownPageTitle } from '@/lib/navigation';
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

/** Why a denial is not about the platform role: no usage scope, or an inactive account. */
export type DeniedReason = 'usage' | 'inactive';

export function deniedReasonHref(path: string, reason: DeniedReason): string {
  return `/?${new URLSearchParams({ denied: path, reason }).toString()}`;
}

const ROLE_NAMES: Record<Role, string> = {
  ADMIN: 'administrator',
  ENGINEER: 'engineer',
  LEAD: 'team lead',
};

/** The notice Home shows, or null when the query carries no (valid) denial. */
export function deniedMessage(
  denied: string | null,
  need: string | null,
  reason: string | null = null
): string | null {
  // Only same-origin paths: this text is shown to the user, and the value is attacker-controllable.
  if (!denied?.startsWith('/') || denied.startsWith('//')) {
    return null;
  }
  // Home itself is where a denial lands; a notice about it would explain nothing.
  if (denied.split('?')[0] === '/') {
    return null;
  }
  const page = knownPageTitle(denied.split('?')[0]) ?? 'this page';
  if (reason === 'inactive') {
    return `Your account is waiting for approval, so you cannot open ${page} yet. Ask an administrator to activate it.`;
  }
  if (reason === 'usage') {
    return `You need access to usage data to open ${page}. Ask an administrator if you think you should have access.`;
  }
  const role = isRole(need) ? `the ${ROLE_NAMES[need]} role` : 'more access';
  return `You need ${role} to open ${page}. Ask an administrator if you think you should have access.`;
}
