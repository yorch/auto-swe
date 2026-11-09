import { hasRole } from '@/lib/roles';

/** The tabs of a team space, in display order. `path` is the segment after `/teams/<slug>`. */
export const TEAM_TABS = [
  { id: 'overview', label: 'Overview', path: '' },
  { id: 'work', label: 'Work', path: 'work' },
  { id: 'automations', label: 'Automations', path: 'automations' },
  { id: 'reports', label: 'Reports', path: 'reports' },
  { id: 'knowledge', label: 'Knowledge', path: 'knowledge' },
  { id: 'members', label: 'Members', path: 'members' },
  { id: 'settings', label: 'Settings', path: 'settings' },
] as const;

export type TeamTabId = (typeof TEAM_TABS)[number]['id'];

/** The address of a team space tab. */
export function teamHref(slug: string, tab: TeamTabId = 'overview'): string {
  const path = TEAM_TABS.find((t) => t.id === tab)?.path ?? '';
  return `/teams/${encodeURIComponent(slug)}${path ? `/${path}` : ''}`;
}

/** The tab a pathname is on: `/teams/<slug>` is the overview; null outside any team space. */
export function teamTabFromPath(pathname: string): TeamTabId | null {
  const match = /^\/teams\/[^/]+(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!match) {
    return null;
  }
  return TEAM_TABS.find((t) => t.path === (match[1] ?? ''))?.id ?? null;
}

/** The slug in `/teams/<slug>/...`, or null outside a team space. */
export function teamSlugFromPath(pathname: string): string | null {
  const match = /^\/teams\/([^/]+)(?:\/|$)/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Settings holds the team's configuration. It is for a team ADMIN or LEAD (the caller's own team
 * role, `myRole`) and for a platform ADMIN, who bypasses team checks.
 */
export function canSeeTeamSettings(
  platformRole: string | null | undefined,
  myRole: string | null | undefined
): boolean {
  return hasRole(platformRole, 'ADMIN') || hasRole(myRole, 'LEAD');
}

/** `Lead`, `Admin`, `Engineer` — how a team role reads in the chrome. */
export const TEAM_ROLE_LABEL: Record<'ADMIN' | 'LEAD' | 'ENGINEER', string> = {
  ADMIN: 'Admin',
  ENGINEER: 'Engineer',
  LEAD: 'Lead',
};
