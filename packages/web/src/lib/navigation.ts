import type { Role } from '@auto-swe/shared';
import { hasRole } from '@/lib/roles';

/**
 * The dashboard's page map: what the sidebar offers, to whom, and what each
 * page is called. One list, so the three things that used to drift apart —
 * the sidebar label, the TopBar title and the page's own H1 — read from the
 * same string.
 *
 * The sidebar has three working groups: Work (daily use), Build (authoring) and
 * Admin. Admin is a single sidebar entry that opens a settings area at `/admin`
 * with its own sub-navigation; its pages are the entry's `children`, grouped by
 * `section`. A group's label is the first segment of its URLs only for Admin:
 * Work and Build pages sit at the top level, so a page keeps its address when it
 * changes group.
 *
 * Heading convention: a page reachable from the navigation is titled with its nav
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
   * A subgroup of a sub-navigation (Admin's Access, Security, …). Items of one
   * section are listed together, in the order they appear here.
   */
  section?: string;
  /** Other path prefixes this entry owns (a sub-area with no navigation entry of its own). */
  alsoActiveFor?: string[];
  /**
   * The pages of an area with its own sub-navigation (Admin). The entry is offered only
   * while at least one child is, and it owns every path under its own href.
   */
  children?: NavItem[];
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** The href of the Admin area: its sidebar entry, its overview page and its URL prefix. */
export const ADMIN_HREF = '/admin';

/** The Approvals page, which carries the sidebar's pending-count badge. */
export const APPROVALS_HREF = '/approvals';

const ADMIN_PAGES: NavItem[] = [
  { href: '/admin/users', icon: 'users', label: 'Users', minRole: 'ADMIN', section: 'Access' },
  { href: '/admin/teams', icon: 'teams', label: 'Teams', minRole: 'ENGINEER', section: 'Access' },
  // GET /platform/organizations and the organizations layout both require LEAD.
  {
    href: '/admin/organizations',
    icon: 'building',
    label: 'Organizations',
    minRole: 'LEAD',
    section: 'Access',
  },
  {
    href: '/admin/sessions',
    icon: 'monitor',
    label: 'Sessions',
    minRole: 'ADMIN',
    section: 'Access',
  },
  {
    href: '/admin/api-tokens',
    icon: 'key',
    label: 'API tokens',
    minRole: 'ADMIN',
    section: 'Access',
  },
  {
    href: '/admin/scanner',
    icon: 'scan',
    label: 'Scanner patterns',
    minRole: 'ADMIN',
    section: 'Security',
  },
  {
    href: '/admin/policies',
    icon: 'security',
    label: 'Autonomy policies',
    minRole: 'ADMIN',
    section: 'Security',
  },
  {
    href: '/admin/policies/decisions',
    icon: 'gavel',
    label: 'Autonomy decisions',
    minRole: 'ADMIN',
    section: 'Security',
  },
  {
    href: '/admin/security',
    icon: 'alert',
    label: 'Security events',
    minRole: 'ADMIN',
    section: 'Security',
  },
  {
    href: '/admin/audit',
    icon: 'list',
    label: 'Audit log',
    minRole: 'ADMIN',
    section: 'Security',
  },
  {
    href: '/admin/activity',
    icon: 'users',
    label: 'User activity',
    minRole: 'ADMIN',
    section: 'Security',
  },
  {
    href: '/admin/analytics',
    icon: 'analytics',
    label: 'Analytics',
    minRole: 'ENGINEER',
    section: 'Spend & insights',
  },
  {
    href: '/admin/reports',
    icon: 'analytics',
    label: 'Reports',
    minRole: 'ENGINEER',
    section: 'Spend & insights',
  },
  // Gated on holding a usage scope (a led team, an administered org, or ADMIN), not on
  // the platform role; the gateway enforces which scopes each may read.
  {
    href: '/admin/usage',
    icon: 'coin',
    label: 'LLM usage',
    minRole: 'ENGINEER',
    needsUsageScope: true,
    section: 'Spend & insights',
  },
  {
    href: '/admin/assistant',
    icon: 'warning',
    label: 'Assistant failures',
    minRole: 'ADMIN',
    section: 'Spend & insights',
  },
  {
    href: '/admin/platform-settings',
    icon: 'settings',
    label: 'Platform settings',
    minRole: 'LEAD',
    section: 'Configuration',
  },
  {
    href: '/admin/workflow-defaults',
    icon: 'workflows',
    label: 'Workflow defaults',
    minRole: 'ADMIN',
    section: 'Configuration',
  },
  {
    href: '/admin/config-grants',
    icon: 'lock',
    label: 'Config grants',
    minRole: 'ADMIN',
    section: 'Configuration',
  },
  // Every automation kind in one list; schedules are still edited on their own page, which
  // keeps this entry lit. The APIs admit ENGINEERs (launch authorization is per repo).
  {
    alsoActiveFor: ['/admin/schedules'],
    href: '/admin/automations',
    icon: 'clock',
    label: 'Automations',
    minRole: 'ENGINEER',
    section: 'Configuration',
  },
  {
    href: '/admin/slack-channels',
    icon: 'chat',
    label: 'Slack channels',
    minRole: 'ENGINEER',
    section: 'Configuration',
  },
  // Platform credentials: administration, not authoring.
  {
    href: '/admin/integrations',
    icon: 'puzzle',
    label: 'Integrations',
    minRole: 'ADMIN',
    section: 'Credentials',
  },
  {
    href: '/admin/github-installations',
    icon: 'github',
    label: 'GitHub installations',
    minRole: 'ADMIN',
    section: 'Credentials',
  },
  // The baselines API and layout both require LEAD.
  {
    href: '/admin/baselines',
    icon: 'target',
    label: 'Error baselines',
    minRole: 'LEAD',
    section: 'Quality',
  },
  {
    href: '/admin/evals',
    icon: 'flask',
    label: 'Evals',
    minRole: 'ADMIN',
    section: 'Quality',
  },
];

export const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { href: '/', icon: 'dashboard', label: 'Home', minRole: 'ENGINEER' },
      { href: APPROVALS_HREF, icon: 'inbox', label: 'Approvals', minRole: 'ENGINEER' },
      {
        alsoActiveFor: ['/epics'],
        href: '/requests',
        icon: 'canvas',
        label: 'Requests',
        minRole: 'ENGINEER',
      },
      { href: '/runs', icon: 'runs', label: 'All runs', minRole: 'ENGINEER' },
      {
        href: '/pull-requests',
        icon: 'pullRequest',
        label: 'Pull requests',
        minRole: 'ENGINEER',
      },
      { href: '/tickets', icon: 'ticket', label: 'Tickets', minRole: 'ENGINEER' },
    ],
    label: 'Work',
  },
  {
    items: [
      { href: '/library', icon: 'templates', label: 'Workflow library', minRole: 'ENGINEER' },
      { href: '/connections', icon: 'connections', label: 'Connections', minRole: 'ENGINEER' },
      // The authoring pages below are ADMIN-only: each route has its own ADMIN layout.
      { href: '/agents', icon: 'agents', label: 'Agents', minRole: 'ADMIN' },
      { href: '/skills', icon: 'skills', label: 'Skills', minRole: 'ADMIN' },
      { href: '/models', icon: 'sliders', label: 'Model configuration', minRole: 'ADMIN' },
      { href: '/mcp', icon: 'plug', label: 'MCP connections', minRole: 'ADMIN' },
      { href: '/bundles', icon: 'package', label: 'Bundles', minRole: 'ADMIN' },
    ],
    label: 'Build',
  },
  {
    // What the agents carry from one run to the next. Every role reads it, scoped to what
    // they can reach; each page keeps its own management controls for those who hold them.
    items: [
      { href: '/knowledge', icon: 'layers', label: 'Knowledge', minRole: 'ENGINEER' },
      { href: '/lessons', icon: 'memory', label: 'Lessons', minRole: 'ENGINEER' },
    ],
    label: 'Knowledge',
  },
  {
    items: [
      {
        children: ADMIN_PAGES,
        href: ADMIN_HREF,
        icon: 'admin',
        label: 'Admin',
        minRole: 'ENGINEER',
      },
    ],
    label: 'Admin',
  },
  {
    items: [
      { href: '/settings', icon: 'settings', label: 'Settings', minRole: 'ENGINEER' },
      { href: '/docs', icon: 'docs', label: 'Docs', minRole: 'ENGINEER' },
    ],
    label: 'Account',
  },
];

/** `items` and, depth first, every child below them. */
export function flattenNavItems(items: NavItem[]): NavItem[] {
  return items.flatMap((item) => [item, ...flattenNavItems(item.children ?? [])]);
}

/** Every page with a navigation entry, sidebar and sub-navigation alike. */
export const NAV_ITEMS: NavItem[] = flattenNavItems(NAV_GROUPS.flatMap((g) => g.items));

function visibleItems(items: NavItem[], role: string | null | undefined, hasUsageScope: boolean) {
  return items.flatMap((item): NavItem[] => {
    if (
      !hasRole(role, item.minRole) ||
      (item.needsUsageScope && !hasUsageScope && !hasRole(role, 'ADMIN'))
    ) {
      return [];
    }
    if (!item.children) {
      return [item];
    }
    const children = visibleItems(item.children, role, hasUsageScope);
    return children.length > 0 ? [{ ...item, children }] : [];
  });
}

/**
 * The groups, each narrowed to the items `role` may open; empty groups dropped. An item
 * with children keeps only the visible ones, and is dropped when none is.
 * `hasUsageScope` unlocks the items gated on a usage scope; an ADMIN always has one.
 */
export function visibleNavGroups(
  role: string | null | undefined,
  hasUsageScope = false
): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: visibleItems(group.items, role, hasUsageScope),
  })).filter((group) => group.items.length > 0);
}

/**
 * Items split into their sections, in first-appearance order.
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

/**
 * The most specific nav item whose href owns `pathname`, if any. An item with children
 * owns everything under its href, so with only the sidebar's items `/admin/users`
 * resolves to `/admin`, and with the Admin children it resolves to `/admin/users`.
 */
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
 * Pages with no navigation entry of their own. Checked before the nav items so a
 * sub-page is not titled after its parent.
 */
const EXTRA_PAGE_TITLES: [string, string][] = [
  ['/runs/', 'Run'],
  ['/start', 'Start work'],
  ['/epics', 'Epics'],
  ['/docs', 'Docs'],
  ['/oauth/consent', 'Authorize app'],
];

/**
 * The TopBar title for `pathname` — the owning nav label, per the convention above — or
 * null when no page claims the path (a real not-found, or a page missing from the tables).
 */
export function knownPageTitle(pathname: string): string | null {
  for (const [prefix, title] of EXTRA_PAGE_TITLES) {
    if (pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)) {
      return title;
    }
  }
  const href = activeNavHref(pathname, NAV_ITEMS);
  const item = NAV_ITEMS.find((i) => i.href === href);
  return item?.label ?? null;
}

/**
 * A title that always renders. A path no page claims gets the generic `fallback`: it
 * may be a chromed page missing from the tables as easily as a missing page, so it is
 * never labelled "Not found" here.
 */
export function pageTitle(pathname: string, fallback = 'Page'): string {
  return knownPageTitle(pathname) ?? fallback;
}

/** The label a page must use as its H1. Throws on an href with no nav entry. */
export function navLabel(href: string): string {
  const item = NAV_ITEMS.find((i) => i.href === href);
  if (!item) {
    throw new Error(`No nav entry for ${href}`);
  }
  return item.label;
}

/** Sections for the pages that have no navigation entry of their own. */
const EXTRA_PAGE_SECTIONS: [string, string][] = [
  ['/start', 'Work'],
  ['/epics', 'Work'],
];

/**
 * The sidebar group a page belongs to — the first half of the TopBar breadcrumb.
 * Null when the page is its own top level (Home) or belongs to no group.
 */
export function pageSection(pathname: string): string | null {
  const href = activeNavHref(pathname, NAV_ITEMS);
  // Docs sits in the Account sidebar group but is help, not account management.
  if (href === '/docs') {
    return 'Help';
  }
  const group = NAV_GROUPS.find((g) => flattenNavItems(g.items).some((i) => i.href === href));
  if (group && pageTitle(pathname) !== 'Home') {
    // A sub-page with its own title (autonomy decisions) still sits in its parent's group.
    return group.label;
  }
  for (const [prefix, section] of EXTRA_PAGE_SECTIONS) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return section;
    }
  }
  return null;
}
