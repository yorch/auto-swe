import type { Access } from '@/lib/capabilities';
import { knownPageTitle } from '@/lib/navigation';

/**
 * A signed-in user who opens a page they lack access to is sent Home with
 * `?denied=<path>&need=<access>`, and Home says why — rather than bouncing
 * them with no explanation.
 */
export function deniedHref(path: string, need: Access): string {
  const params = new URLSearchParams({ denied: path, need });
  return `/?${params.toString()}`;
}

/** Why a denial is not about a permission: no usage scope, or an inactive account. */
export type DeniedReason = 'usage' | 'inactive';

export function deniedReasonHref(path: string, reason: DeniedReason): string {
  return `/?${new URLSearchParams({ denied: path, reason }).toString()}`;
}

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
    return `Your account is waiting for approval, so you cannot open ${page} yet. Ask a platform admin to activate it.`;
  }
  if (reason === 'usage') {
    return `You need access to usage data to open ${page}. Ask a platform admin if you think you should have access.`;
  }
  // `need` is attacker-controllable text: only the one word it may name is read, nothing is echoed.
  const what = need === 'platform-admin' ? 'the platform admin role' : 'more access';
  const note =
    need === 'platform-admin' ? ' Team and organization admin roles do not include this page.' : '';
  return `You need ${what} to open ${page}.${note} Ask a platform admin if you think you should have access.`;
}
