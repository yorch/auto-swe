/** The tabs of a team space, in display order. `path` is the segment after `/teams/<slug>`. */
export const TEAM_TABS = [
  { id: 'overview', label: 'Overview', path: '' },
  { id: 'work', label: 'Work', path: 'work' },
  { id: 'automations', label: 'Automations', path: 'automations' },
  { id: 'reports', label: 'Reports', path: 'reports' },
  { id: 'knowledge', label: 'Knowledge', path: 'knowledge' },
  { id: 'members', label: 'Members', path: 'members' },
  { id: 'manage', label: 'Manage', path: 'manage' },
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
