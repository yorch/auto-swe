import type { Access, Permissions } from '@/lib/capabilities';
import { holdsAccess } from '@/lib/capabilities';

/** URL-scoped lists, the cross-team desk, and team spaces support team navigation. */
export function showsTeamSwitcher(pathname: string): boolean {
  return (
    /^\/teams\/[^/]+(?:\/|$)/.test(pathname) ||
    [
      '/',
      '/approvals',
      '/requests',
      '/runs',
      '/pull-requests',
      '/tickets',
      '/epics',
      '/start',
      '/library',
      '/knowledge',
      '/automations',
      '/insights/reports',
    ].includes(pathname.replace(/\/$/, '') || '/')
  );
}

export interface DetailParent {
  href: string;
  label: string;
  section?: string;
}

/** Route families with real detail pages; dialog-only entities stay on their list. */
export function detailParent(pathname: string): DetailParent | null {
  const parents: [RegExp, DetailParent][] = [
    [/^\/library\/[^/]+(?:\/|$)/, { href: '/library', label: 'Workflow library' }],
    [/^\/runs\/[^/]+\/?$/, { href: '/runs', label: 'All runs' }],
    [/^\/requests\/[^/]+\/?$/, { href: '/requests', label: 'Requests' }],
    [/^\/pull-requests\/[^/]+\/?$/, { href: '/pull-requests', label: 'Pull requests' }],
    [/^\/epics\/[^/]+\/?$/, { href: '/epics', label: 'Epics' }],
    [/^\/campaigns\/[^/]+\/?$/, { href: '/campaigns', label: 'Campaigns' }],
    [/^\/orchestrations\/[^/]+\/?$/, { href: '/orchestrations', label: 'Orchestrations' }],
    [/^\/docs\/[^/]+\/?$/, { href: '/docs', label: 'Docs' }],
    [/^\/teams\/[^/]+(?:\/|$)/, { href: '/teams', label: 'Teams', section: 'Teams' }],
    [/^\/admin\/teams\/[^/]+\/?$/, { href: '/teams', label: 'Teams' }],
    [
      /^\/admin\/organizations\/[^/]+\/?$/,
      { href: '/admin/organizations', label: 'Organizations' },
    ],
    [
      /^\/admin\/slack-channels\/[^/]+\/?$/,
      { href: '/admin/slack-channels', label: 'Slack channels' },
    ],
    [/^\/admin\/evals\/(?:runs|datasets)\/[^/]+\/?$/, { href: '/admin/evals', label: 'Evals' }],
  ];
  return parents.find(([pattern]) => pattern.test(pathname))?.[1] ?? null;
}

/**
 * The dashboard's page map: what the sidebar offers, to whom, and what each
 * page is called. One list, so the three things that used to drift apart —
 * the sidebar label, the TopBar title and the page's own H1 — read from the
 * same string.
 *
 * Work, Build, Connect and Knowledge lead to pages; Admin is a single sidebar
 * entry that opens a settings area at `/admin`
 * with its own sub-navigation; its pages are the entry's `children`, grouped by
 * `section`. A group's label is the first segment of its URLs only for Admin:
 * Work and Build pages sit at the top level, so a page keeps its address when it
 * changes group.
 *
 * Heading convention: a page reachable from the navigation is titled with its nav
 * label, verbatim — no trailing period, no "Admin —" prefix. The TopBar shows
 * the same string. A detail page (one template, one team, one run) titles its
 * H1 with the entity's name and publishes it to the TopBar breadcrumb.
 *
 * `access` must match what actually serves the page: the route's `AccessLayout` guard and the
 * capability the gateway requires of the API it reads. A nav entry that is more permissive than
 * the layout bounces users; one that is stricter hides a page they are allowed to use.
 */
export interface NavItem {
  href: string;
  label: string;
  icon: string;
  access: Access;
  /**
   * Offered only to someone who may read a usage scope (`GET /platform/usage/scopes`), however
   * they came by it: a team lead or an organization admin by membership qualifies.
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
  {
    access: 'platform-admin',
    href: '/admin/users',
    icon: 'users',
    label: 'Users',
    section: 'Access',
  },
  {
    access: 'any',
    href: '/admin/organizations',
    icon: 'building',
    label: 'Organizations',
    section: 'Access',
  },
  {
    access: 'platform-admin',
    href: '/admin/sessions',
    icon: 'monitor',
    label: 'Sessions',
    section: 'Access',
  },
  {
    access: 'platform-admin',
    href: '/admin/api-tokens',
    icon: 'key',
    label: 'API tokens',
    section: 'Access',
  },
  {
    access: 'platform-admin',
    href: '/admin/scanner',
    icon: 'scan',
    label: 'Scanner patterns',
    section: 'Security',
  },
  {
    access: 'platform-admin',
    href: '/admin/harness-profiles',
    icon: 'package',
    label: 'Plugins',
    section: 'Security',
  },
  {
    access: 'platform-admin',
    href: '/admin/pr-evaluations',
    icon: 'filter',
    label: 'PR evaluations',
    section: 'Security',
  },
  {
    access: 'platform-admin',
    href: '/admin/policies',
    icon: 'security',
    label: 'Autonomy policies',
    section: 'Security',
  },
  {
    access: 'platform-admin',
    href: '/admin/policies/decisions',
    icon: 'gavel',
    label: 'Autonomy decisions',
    section: 'Security',
  },
  {
    access: 'platform-admin',
    href: '/admin/security',
    icon: 'alert',
    label: 'Security events',
    section: 'Security',
  },
  {
    access: 'platform-admin',
    href: '/admin/audit',
    icon: 'list',
    label: 'Audit log',
    section: 'Security',
  },
  {
    access: 'platform-admin',
    href: '/admin/activity',
    icon: 'users',
    label: 'User activity',
    section: 'Security',
  },
  {
    access: 'platform-admin',
    href: '/admin/user-analytics',
    icon: 'analytics',
    label: 'User analytics',
    section: 'Security',
  },
  {
    access: 'platform-admin',
    href: '/admin/assistant',
    icon: 'warning',
    label: 'Assistant failures',
    section: 'Spend & insights',
  },
  {
    access: 'settings-writer',
    href: '/admin/platform-settings',
    icon: 'settings',
    label: 'Platform settings',
    section: 'Configuration',
  },
  {
    access: 'platform-admin',
    href: '/admin/workflow-defaults',
    icon: 'workflows',
    label: 'Workflow defaults',
    section: 'Configuration',
  },
  {
    access: 'platform-admin',
    href: '/admin/review-presets',
    icon: 'checkCircle',
    label: 'Platform review presets',
    section: 'Configuration',
  },
  {
    access: 'platform-admin',
    href: '/admin/config-grants',
    icon: 'lock',
    label: 'Config grants',
    section: 'Configuration',
  },
  {
    access: 'any',
    href: '/admin/slack-channels',
    icon: 'chat',
    label: 'Slack channels',
    section: 'Configuration',
  },
  // Platform credentials: administration, not authoring.
  {
    access: 'platform-admin',
    href: '/admin/integrations',
    icon: 'puzzle',
    label: 'Integrations',
    section: 'Credentials',
  },
  {
    access: 'platform-admin',
    href: '/admin/github-installations',
    icon: 'github',
    label: 'GitHub installations',
    section: 'Credentials',
  },
  // The baselines API answers to organization membership (`org.baselines.read`).
  {
    access: 'org.baselines.read',
    href: '/admin/baselines',
    icon: 'target',
    label: 'Error baselines',
    section: 'Quality',
  },
  {
    access: 'platform-admin',
    href: '/admin/evals',
    icon: 'flask',
    label: 'Evals',
    section: 'Quality',
  },
];

/**
 * Pages every role may open, which used to sit in Admin. What each shows is narrowed by the gateway
 * to the caller's teams and scopes. A team's own page is `/teams/<slug>`, which the Teams entry owns.
 */
export const INSIGHTS_PAGES: NavItem[] = [
  { access: 'any', href: '/teams', icon: 'teams', label: 'Teams' },
  { access: 'any', href: '/insights/analytics', icon: 'analytics', label: 'Analytics' },
  { access: 'any', href: '/insights/reports', icon: 'docs', label: 'Reports' },
  // Gated on holding a usage scope (a led team, an administered org, or a platform admin), not on
  // the platform role; the gateway enforces which scopes each may read.
  {
    access: 'any',
    href: '/insights/usage',
    icon: 'coin',
    label: 'LLM usage',
    needsUsageScope: true,
  },
  // Every automation kind in one list; schedules are still edited on their own page, which
  // keeps this entry lit. The APIs admit every signed-in person (launch authorization is per repo).
  {
    access: 'any',
    alsoActiveFor: ['/admin/schedules'],
    href: '/automations',
    icon: 'clock',
    label: 'Automations',
  },
];

export const KNOWLEDGE_PAGES: NavItem[] = [
  { access: 'any', href: '/knowledge', icon: 'repository', label: 'Knowledge' },
  { access: 'any', href: '/knowledge-bases', icon: 'memory', label: 'Knowledge bases' },
  { access: 'any', href: '/lessons', icon: 'edit', label: 'Lessons' },
];

export const NAV_GROUPS: NavGroup[] = [
  {
    items: [{ access: 'any', href: '/', icon: 'dashboard', label: 'Home' }],
    label: 'Home',
  },
  {
    items: [
      { access: 'any', href: APPROVALS_HREF, icon: 'inbox', label: 'Approvals' },
      {
        access: 'any',
        href: '/requests',
        icon: 'canvas',
        label: 'Requests',
      },
      { access: 'any', href: '/epics', icon: 'epics', label: 'Epics' },
      { access: 'any', href: '/campaigns', icon: 'layers', label: 'Campaigns' },
      { access: 'any', href: '/orchestrations', icon: 'branch', label: 'Orchestrations' },
      { access: 'any', href: '/runs', icon: 'runs', label: 'All runs' },
      {
        access: 'any',
        href: '/pull-requests',
        icon: 'pullRequest',
        label: 'Pull requests',
      },
      { access: 'any', href: '/tickets', icon: 'ticket', label: 'Tickets' },
    ],
    label: 'All teams',
  },
  { items: INSIGHTS_PAGES, label: 'Teams and insights' },
  {
    items: [
      { access: 'any', href: '/library', icon: 'templates', label: 'Workflow library' },
      // The authoring pages below are for platform administrators: each route has its own layout.
      { access: 'platform-admin', href: '/agents', icon: 'agents', label: 'Agents' },
      { access: 'platform-admin', href: '/skills', icon: 'skills', label: 'Skills' },
      {
        access: 'any',
        href: '/review-presets',
        icon: 'checkCircle',
        label: 'Review presets',
      },
    ],
    label: 'Build',
  },
  {
    items: [
      { access: 'any', href: '/connections', icon: 'connections', label: 'Connections' },
      { access: 'platform-admin', href: '/models', icon: 'sliders', label: 'Model configuration' },
      { access: 'platform-admin', href: '/mcp', icon: 'plug', label: 'MCP connections' },
      { access: 'platform-admin', href: '/bundles', icon: 'package', label: 'Bundles' },
    ],
    label: 'Connect',
  },
  {
    // What the agents carry from one run to the next. Every role reads it, scoped to what
    // they can reach; each page keeps its own management controls for those who hold them.
    items: [
      {
        ...KNOWLEDGE_PAGES[0],
        alsoActiveFor: ['/knowledge-bases', '/lessons'],
        children: KNOWLEDGE_PAGES.slice(1),
      },
    ],
    label: 'Knowledge',
  },
  {
    items: [
      {
        access: 'any',
        children: ADMIN_PAGES,
        href: ADMIN_HREF,
        icon: 'admin',
        label: 'Admin',
      },
    ],
    label: 'Admin',
  },
];

export const USER_NAV_ITEMS: NavItem[] = [
  { access: 'any', href: '/settings', icon: 'settings', label: 'Settings' },
  { access: 'any', href: '/docs', icon: 'docs', label: 'Docs' },
];

/** `items` and, depth first, every child below them. */
export function flattenNavItems(items: NavItem[]): NavItem[] {
  return items.flatMap((item) => [item, ...flattenNavItems(item.children ?? [])]);
}

/** Every page with a navigation entry, sidebar and sub-navigation alike. */
export const NAV_ITEMS: NavItem[] = flattenNavItems([
  ...NAV_GROUPS.flatMap((g) => g.items),
  ...USER_NAV_ITEMS,
]);

function visibleItems(
  items: NavItem[],
  perms: Permissions | null | undefined,
  hasUsageScope: boolean
) {
  return items.flatMap((item): NavItem[] => {
    if (
      !holdsAccess(perms, item.access) ||
      (item.needsUsageScope && !hasUsageScope && !holdsAccess(perms, 'platform-admin'))
    ) {
      return [];
    }
    if (!item.children) {
      return [item];
    }
    const children = visibleItems(item.children, perms, hasUsageScope);
    return children.length > 0 ? [{ ...item, children }] : [];
  });
}

/**
 * The groups, each narrowed to the items the server's effective permissions (`perms`) let the
 * person open; empty groups dropped. An item with children keeps only the visible ones, and is
 * dropped when none is. `hasUsageScope` unlocks the items gated on a usage scope; a platform
 * administrator always has one. Before `perms` loads, only the items open to everyone show.
 */
export function visibleNavGroups(
  perms: Permissions | null | undefined,
  hasUsageScope = false
): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: visibleItems(group.items, perms, hasUsageScope),
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
    .flatMap((item) => {
      if (item.href === '/') {
        return [];
      }
      return [item.href, ...(item.alsoActiveFor ?? [])].filter(owns).map((prefix) => ({
        direct: prefix === item.href,
        href: item.href,
        length: prefix.length,
      }));
    })
    .sort((a, b) => b.length - a.length || Number(b.direct) - Number(a.direct))[0];
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
  // A team's own space; the bare `/teams` is the directory and is titled by its nav entry.
  ['/teams/', 'Team'],
  // A team's admin page keeps its address; its list moved, so the title says which list it is.
  ['/admin/teams/', 'Teams'],
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
  ['/docs', 'Help'],
  ['/settings', 'Account'],
  ['/start', 'All teams'],
  ['/epics', 'All teams'],
];

/**
 * The sidebar group a page belongs to — the first half of the TopBar breadcrumb.
 * Null when the page is its own top level (Home) or belongs to no group.
 */
export function pageSection(pathname: string): string | null {
  const href = activeNavHref(pathname, NAV_ITEMS);
  // Docs is a user-menu destination and belongs to Help, not account management.
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
