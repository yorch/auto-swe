import type { Role } from '@auto-swe/shared';
import { hasRole } from '@/lib/roles';

/**
 * The dashboard's page map: what the sidebar offers, to whom, and what each
 * page is called. One list, so the three things that used to drift apart —
 * the sidebar label, the TopBar title and the page's own H1 — read from the
 * same string.
 *
 * Heading convention: a page reachable from the sidebar is titled with its nav
 * label, verbatim — no trailing period, no "Admin —" prefix. The TopBar shows
 * the same string. A detail page (one template, one team, one run) titles its
 * H1 with the entity's name and the TopBar keeps the section's label.
 *
 * `minRole` must match what actually serves the page: the route's
 * `RoleLayout` guard and the gateway `requiredRole` of the API it reads.
 * A nav entry that is more permissive than the layout bounces users; one that
 * is stricter hides a page they are allowed to use.
 */
export interface NavItem {
  href: string;
  label: string;
  icon: string;
  minRole: Role;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    items: [{ href: '/', icon: 'dashboard', label: 'Home', minRole: 'ENGINEER' }],
    label: 'Start',
  },
  {
    items: [{ href: '/workflows', icon: 'canvas', label: 'Request queue', minRole: 'ENGINEER' }],
    label: 'Requests',
  },
  {
    items: [
      {
        href: '/workflows/library',
        icon: 'templates',
        label: 'Workflow library',
        minRole: 'ENGINEER',
      },
      // Listing connections is an ENGINEER route; the page hides the LEAD-only
      // add / import / edit controls itself.
      { href: '/connections', icon: 'connections', label: 'Connections', minRole: 'ENGINEER' },
      { href: '/runs', icon: 'runs', label: 'Runs', minRole: 'ENGINEER' },
    ],
    label: 'Workflows',
  },
  {
    // Everything under /studio sits behind the ADMIN-only studio layout.
    items: [
      { href: '/studio/agents/library', icon: 'agents', label: 'Agents', minRole: 'ADMIN' },
      { href: '/studio/skills', icon: 'skills', label: 'Skills', minRole: 'ADMIN' },
      { href: '/studio/mcp', icon: 'connections', label: 'MCP connections', minRole: 'ADMIN' },
      {
        href: '/studio/integrations',
        icon: 'connections',
        label: 'Integrations',
        minRole: 'ADMIN',
      },
      {
        href: '/studio/github-installations',
        icon: 'connections',
        label: 'GitHub installations',
        minRole: 'ADMIN',
      },
      { href: '/studio/models', icon: 'admin', label: 'Model configuration', minRole: 'ADMIN' },
      { href: '/studio/bundles', icon: 'templates', label: 'Bundles', minRole: 'ADMIN' },
    ],
    label: 'Studio',
  },
  {
    items: [
      { href: '/govern/security', icon: 'security', label: 'Security events', minRole: 'ADMIN' },
      { href: '/govern/scanner', icon: 'security', label: 'Scanner patterns', minRole: 'ADMIN' },
      {
        href: '/govern/policies',
        icon: 'security',
        label: 'Autonomy policies',
        minRole: 'ADMIN',
      },
      { href: '/govern/evals', icon: 'analytics', label: 'Evals', minRole: 'ADMIN' },
      // The schedules API admits ENGINEERs (launch authorization is per repo).
      { href: '/govern/schedules', icon: 'clock', label: 'Schedules', minRole: 'ENGINEER' },
      {
        href: '/govern/budget-alerts',
        icon: 'security',
        label: 'Budget alerts',
        minRole: 'ADMIN',
      },
      { href: '/govern/teams', icon: 'teams', label: 'Teams', minRole: 'ENGINEER' },
      // GET /platform/organizations and the budgets layout both require LEAD.
      { href: '/govern/budgets', icon: 'teams', label: 'Organizations', minRole: 'LEAD' },
      { href: '/govern/users', icon: 'users', label: 'Users', minRole: 'ADMIN' },
      { href: '/govern/api-tokens', icon: 'key', label: 'API tokens', minRole: 'ADMIN' },
      { href: '/govern/approvals', icon: 'inbox', label: 'Approvals', minRole: 'ENGINEER' },
      { href: '/govern/lessons', icon: 'memory', label: 'Lessons', minRole: 'ADMIN' },
      { href: '/govern/analytics', icon: 'analytics', label: 'Analytics', minRole: 'ENGINEER' },
      // The baselines API and layout both require LEAD.
      { href: '/govern/baselines', icon: 'analytics', label: 'Error baselines', minRole: 'LEAD' },
      { href: '/govern/sessions', icon: 'clock', label: 'Sessions', minRole: 'ADMIN' },
      { href: '/govern/slack-channels', icon: 'teams', label: 'Slack channels', minRole: 'ADMIN' },
      {
        href: '/govern/workflow-defaults',
        icon: 'workflows',
        label: 'Workflow defaults',
        minRole: 'ADMIN',
      },
      {
        href: '/govern/platform-settings',
        icon: 'settings',
        label: 'Platform settings',
        minRole: 'LEAD',
      },
      { href: '/govern/config-grants', icon: 'settings', label: 'Config grants', minRole: 'ADMIN' },
      { href: '/govern/audit', icon: 'analytics', label: 'Audit log', minRole: 'ADMIN' },
    ],
    label: 'Govern',
  },
  {
    items: [{ href: '/settings', icon: 'settings', label: 'Settings', minRole: 'ENGINEER' }],
    label: 'Account',
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** The groups, each narrowed to the items `role` may open; empty groups dropped. */
export function visibleNavGroups(role: string | null | undefined): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => hasRole(role, item.minRole)),
  })).filter((group) => group.items.length > 0);
}

/** The most specific nav item whose href owns `pathname`, if any. */
export function activeNavHref(pathname: string, items: NavItem[]): string {
  if (pathname === '/') {
    return '/';
  }
  const match = items
    .filter(
      (item) =>
        item.href !== '/' && (pathname === item.href || pathname.startsWith(`${item.href}/`))
    )
    .sort((a, b) => b.href.length - a.href.length)[0];
  return match?.href ?? '';
}

/**
 * Pages with no sidebar entry of their own. Checked before the nav items so a
 * sub-page (`/govern/policies/decisions`) is not titled after its parent.
 */
const EXTRA_PAGE_TITLES: [string, string][] = [
  ['/runs/', 'Run'],
  ['/govern/policies/decisions', 'Autonomy decisions'],
  ['/epics', 'Epics'],
  ['/docs', 'Docs'],
  ['/lessons', 'Lessons'],
];

/** The TopBar title for `pathname` — the owning nav label, per the convention above. */
export function pageTitle(pathname: string): string {
  for (const [prefix, title] of EXTRA_PAGE_TITLES) {
    if (pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)) {
      return title;
    }
  }
  const href = activeNavHref(pathname, NAV_ITEMS);
  const item = NAV_ITEMS.find((i) => i.href === href);
  if (item) {
    return item.label;
  }
  if (pathname.startsWith('/govern')) {
    return 'Govern';
  }
  if (pathname.startsWith('/studio')) {
    return 'Studio';
  }
  return 'auto·swe';
}

/** The label a page must use as its H1. Throws on an href with no nav entry. */
export function navLabel(href: string): string {
  const item = NAV_ITEMS.find((i) => i.href === href);
  if (!item) {
    throw new Error(`No nav entry for ${href}`);
  }
  return item.label;
}
