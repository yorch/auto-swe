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
  /**
   * Offered only to someone who may read a usage scope (`GET /platform/usage/scopes`),
   * whatever their platform role: a team LEAD or ORG_ADMIN by membership qualifies.
   */
  needsUsageScope?: true;
  /**
   * A collapsible subgroup inside the group (Govern's Access, Security, …). Items
   * of one section are listed together, in the order they appear here.
   */
  section?: string;
  /** Other path prefixes this entry owns (a sub-area with no sidebar entry of its own). */
  alsoActiveFor?: string[];
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { href: '/', icon: 'dashboard', label: 'Home', minRole: 'ENGINEER' },
      {
        alsoActiveFor: ['/epics'],
        href: '/workflows',
        icon: 'canvas',
        label: 'Requests',
        minRole: 'ENGINEER',
      },
      { href: '/runs', icon: 'runs', label: 'All runs', minRole: 'ENGINEER' },
      { href: '/govern/approvals', icon: 'inbox', label: 'Approvals', minRole: 'ENGINEER' },
      {
        href: '/workflows/library',
        icon: 'templates',
        label: 'Workflow library',
        minRole: 'ENGINEER',
      },
      { href: '/connections', icon: 'connections', label: 'Connections', minRole: 'ENGINEER' },
    ],
    label: 'Work',
  },
  {
    // Everything under /studio sits behind the ADMIN-only studio layout.
    items: [
      { href: '/studio/agents/library', icon: 'agents', label: 'Agents', minRole: 'ADMIN' },
      { href: '/studio/skills', icon: 'skills', label: 'Skills', minRole: 'ADMIN' },
      { href: '/studio/mcp', icon: 'plug', label: 'MCP connections', minRole: 'ADMIN' },
      {
        href: '/studio/integrations',
        icon: 'layers',
        label: 'Integrations',
        minRole: 'ADMIN',
      },
      {
        href: '/studio/github-installations',
        icon: 'github',
        label: 'GitHub installations',
        minRole: 'ADMIN',
      },
      { href: '/studio/models', icon: 'sliders', label: 'Model configuration', minRole: 'ADMIN' },
      { href: '/studio/bundles', icon: 'package', label: 'Bundles', minRole: 'ADMIN' },
    ],
    label: 'Studio',
  },
  {
    items: [
      {
        href: '/govern/users',
        icon: 'users',
        label: 'Users',
        minRole: 'ADMIN',
        section: 'Access',
      },
      {
        href: '/govern/teams',
        icon: 'teams',
        label: 'Teams',
        minRole: 'ENGINEER',
        section: 'Access',
      },
      // GET /platform/organizations and the organizations layout both require LEAD.
      {
        // Budget alerts is the "Alerting only" filter here now; the old URL redirects.
        alsoActiveFor: ['/govern/budget-alerts'],
        href: '/govern/organizations',
        icon: 'building',
        label: 'Organizations',
        minRole: 'LEAD',
        section: 'Access',
      },
      {
        href: '/govern/sessions',
        icon: 'monitor',
        label: 'Sessions',
        minRole: 'ADMIN',
        section: 'Access',
      },
      {
        href: '/govern/api-tokens',
        icon: 'key',
        label: 'API tokens',
        minRole: 'ADMIN',
        section: 'Access',
      },
      {
        href: '/govern/scanner',
        icon: 'scan',
        label: 'Scanner patterns',
        minRole: 'ADMIN',
        section: 'Security',
      },
      {
        href: '/govern/policies',
        icon: 'security',
        label: 'Autonomy policies',
        minRole: 'ADMIN',
        section: 'Security',
      },
      {
        href: '/govern/policies/decisions',
        icon: 'gavel',
        label: 'Autonomy decisions',
        minRole: 'ADMIN',
        section: 'Security',
      },
      {
        href: '/govern/security',
        icon: 'alert',
        label: 'Security events',
        minRole: 'ADMIN',
        section: 'Security',
      },
      {
        href: '/govern/audit',
        icon: 'list',
        label: 'Audit log',
        minRole: 'ADMIN',
        section: 'Security',
      },
      {
        href: '/govern/analytics',
        icon: 'analytics',
        label: 'Analytics',
        minRole: 'ENGINEER',
        section: 'Spend & insights',
      },
      // Gated on holding a usage scope (a led team, an administered org, or ADMIN), not on
      // the platform role; the gateway enforces which scopes each may read.
      {
        href: '/govern/usage',
        icon: 'coin',
        label: 'LLM usage',
        minRole: 'ENGINEER',
        needsUsageScope: true,
        section: 'Spend & insights',
      },
      {
        href: '/govern/platform-settings',
        icon: 'settings',
        label: 'Platform settings',
        minRole: 'LEAD',
        section: 'Configuration',
      },
      {
        href: '/govern/workflow-defaults',
        icon: 'workflows',
        label: 'Workflow defaults',
        minRole: 'ADMIN',
        section: 'Configuration',
      },
      {
        href: '/govern/config-grants',
        icon: 'lock',
        label: 'Config grants',
        minRole: 'ADMIN',
        section: 'Configuration',
      },
      // The schedules API admits ENGINEERs (launch authorization is per repo).
      {
        href: '/govern/schedules',
        icon: 'clock',
        label: 'Schedules',
        minRole: 'ENGINEER',
        section: 'Configuration',
      },
      {
        href: '/govern/slack-channels',
        icon: 'chat',
        label: 'Slack channels',
        minRole: 'ADMIN',
        section: 'Configuration',
      },
      {
        href: '/govern/lessons',
        icon: 'memory',
        label: 'Lessons',
        minRole: 'ADMIN',
        section: 'Knowledge',
      },
      // The baselines API and layout both require LEAD.
      {
        href: '/govern/baselines',
        icon: 'target',
        label: 'Error baselines',
        minRole: 'LEAD',
        section: 'Knowledge',
      },
      {
        href: '/govern/evals',
        icon: 'flask',
        label: 'Evals',
        minRole: 'ADMIN',
        section: 'Knowledge',
      },
    ],
    label: 'Govern',
  },
  {
    items: [
      { href: '/settings', icon: 'settings', label: 'Settings', minRole: 'ENGINEER' },
      { href: '/docs', icon: 'docs', label: 'Docs', minRole: 'ENGINEER' },
    ],
    label: 'Account',
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/**
 * The groups, each narrowed to the items `role` may open; empty groups dropped.
 * `hasUsageScope` unlocks the items gated on a usage scope; an ADMIN always has one.
 */
export function visibleNavGroups(
  role: string | null | undefined,
  hasUsageScope = false
): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) =>
        hasRole(role, item.minRole) &&
        (!item.needsUsageScope || hasUsageScope || hasRole(role, 'ADMIN'))
    ),
  })).filter((group) => group.items.length > 0);
}

/**
 * A group's visible items split into its sections, in first-appearance order.
 * An item with no section lands in an unnamed leading block (`label: null`).
 */
export function navSections(items: NavItem[]): { label: string | null; items: NavItem[] }[] {
  const out: { label: string | null; items: NavItem[] }[] = [];
  for (const item of items) {
    const label = item.section ?? null;
    let block = out.find((b) => b.label === label);
    if (!block) {
      block = { items: [], label };
      out.push(block);
    }
    block.items.push(item);
  }
  return out;
}

/** The most specific nav item whose href owns `pathname`, if any. */
export function activeNavHref(pathname: string, items: NavItem[]): string {
  if (pathname === '/') {
    return '/';
  }
  const owns = (prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);
  const match = items
    .flatMap((item) =>
      item.href === '/'
        ? []
        : [item.href, ...(item.alsoActiveFor ?? [])]
            .filter(owns)
            .map((prefix) => ({ href: item.href, length: prefix.length }))
    )
    .sort((a, b) => b.length - a.length)[0];
  return match?.href ?? '';
}

/** True on the Start work page, which the sidebar's persistent button owns. */
export function isStartWorkPath(pathname: string): boolean {
  return pathname === '/start' || pathname.startsWith('/start/');
}

/**
 * Pages with no sidebar entry of their own. Checked before the nav items so a
 * sub-page (`/govern/policies/decisions`) is not titled after its parent.
 */
const EXTRA_PAGE_TITLES: [string, string][] = [
  ['/runs/', 'Run'],
  ['/start', 'Start work'],
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

/** Sections for the pages that have no sidebar entry of their own. */
const EXTRA_PAGE_SECTIONS: [string, string][] = [
  ['/start', 'Work'],
  ['/epics', 'Work'],
  ['/docs', 'Account'],
  ['/lessons', 'Govern'],
];

/**
 * The sidebar group a page belongs to — the first half of the TopBar breadcrumb.
 * Null when the page is its own top level (Home) or belongs to no group.
 */
export function pageSection(pathname: string): string | null {
  const href = activeNavHref(pathname, NAV_ITEMS);
  const group = NAV_GROUPS.find((g) => g.items.some((i) => i.href === href));
  if (group && pageTitle(pathname) !== 'Home') {
    // A sub-page with its own title (autonomy decisions) still sits in its parent's group.
    return group.label;
  }
  for (const [prefix, section] of EXTRA_PAGE_SECTIONS) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return section;
    }
  }
  if (pathname.startsWith('/govern')) {
    return 'Govern';
  }
  if (pathname.startsWith('/studio')) {
    return 'Studio';
  }
  return null;
}
