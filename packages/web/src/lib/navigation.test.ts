import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@auto-swe/shared';
import { describe, expect, it } from 'vitest';
import { ICON_PATHS, isIconName } from '@/components/ui/Icon';
import { hasRole } from '@/lib/roles';
import {
  ADMIN_HREF,
  activeNavHref,
  detailParent,
  flattenNavItems,
  isStartWorkPath,
  knownPageTitle,
  NAV_GROUPS,
  NAV_ITEMS,
  navLabel,
  navSections,
  pageSection,
  pageTitle,
  showsTeamSwitcher,
  USER_NAV_ITEMS,
  visibleNavGroups,
} from './navigation';

describe('team switcher scope', () => {
  it.each([
    '/',
    '/approvals',
    '/requests',
    '/runs',
    '/pull-requests',
    '/tickets',
    '/epics',
    '/start',
    '/teams/default',
    '/teams/default/work',
    '/library',
    '/knowledge',
    '/admin/automations',
    '/admin/reports',
  ])('shows on team-aware route %s', (path) => {
    expect(showsTeamSwitcher(path)).toBe(true);
  });
  it.each([
    '/admin/users',
    '/settings',
    '/docs',
    '/docs/architecture',
    '/connections',
    '/models',
    '/mcp',
    '/bundles',
    '/agents',
    '/skills',
    '/review-presets',
    '/knowledge-bases',
    '/lessons',
    '/library/id',
    '/library/id/diff',
    '/runs/id',
    '/pull-requests/id',
    '/requests/id',
    '/epics/id',
    '/teams-not-a-space',
  ])('hides on unscoped route %s', (path) => {
    expect(showsTeamSwitcher(path)).toBe(false);
  });
});

describe('detail parents', () => {
  it.each([
    ['/runs/id', '/runs'],
    ['/requests/id', '/requests'],
    ['/library/id', '/library'],
    ['/library/id/diff', '/library'],
    ['/library/id/analytics', '/library'],
    ['/library/id/runs', '/library'],
    ['/pull-requests/id', '/pull-requests'],
    ['/docs/architecture', '/docs'],
    ['/epics/id', '/epics'],
    ['/teams/default', '/admin/teams'],
    ['/teams/default/settings', '/admin/teams'],
    ['/admin/teams/id', '/admin/teams'],
    ['/admin/organizations/id', '/admin/organizations'],
    ['/admin/slack-channels/id', '/admin/slack-channels'],
    ['/admin/evals/datasets/id', '/admin/evals'],
    ['/admin/evals/runs/id', '/admin/evals'],
  ])('links %s to %s', (path, href) => expect(detailParent(path)?.href).toBe(href));
  it.each(['/', '/requests', '/library', '/agents', '/knowledge-bases', '/not-found'])(
    'adds no detail chrome on %s',
    (path) => expect(detailParent(path)).toBeNull()
  );
});

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const RANK: Record<Role, number> = { ADMIN: 3, ENGINEER: 1, LEAD: 2 };

/**
 * The strictest `RoleLayout allowed={[…]}` floor on the way from the app root
 * to `href` — what the server actually enforces for that page.
 */
function layoutFloor(href: string): Role {
  const segments = href.split('/').filter(Boolean);
  let floor: Role = 'ENGINEER';
  for (let i = 0; i <= segments.length; i++) {
    const file = join(APP_DIR, ...segments.slice(0, i), 'layout.tsx');
    if (!existsSync(file)) {
      continue;
    }
    const match = readFileSync(file, 'utf8').match(/allowed=\{\[([^\]]*)\]\}/);
    if (!match) {
      continue;
    }
    const roles = [...match[1].matchAll(/'(ENGINEER|LEAD|ADMIN)'/g)].map((m) => m[1] as Role);
    const lowest = roles.reduce<Role>((lo, r) => (RANK[r] < RANK[lo] ? r : lo), 'ADMIN');
    if (RANK[lowest] > RANK[floor]) {
      floor = lowest;
    }
  }
  return floor;
}

describe('NAV_GROUPS', () => {
  it('uses visually distinct glyphs for every sidebar destination', () => {
    const glyphs = NAV_GROUPS.flatMap((group) =>
      group.items.map((item) => {
        if (!isIconName(item.icon)) {
          throw new Error(`Unknown sidebar icon: ${item.icon}`);
        }
        return ICON_PATHS[item.icon];
      })
    );
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
  it('has one Knowledge destination while keeping each tab discoverable', () => {
    const items = NAV_GROUPS.find((group) => group.label === 'Knowledge')?.items ?? [];
    expect(items.map((item) => item.href)).toEqual(['/knowledge']);
    for (const href of ['/knowledge', '/knowledge-bases', '/lessons']) {
      expect(activeNavHref(`${href}/detail`, items)).toBe('/knowledge');
      expect(pageSection(`${href}/detail`)).toBe('Knowledge');
      expect(NAV_ITEMS.some((item) => item.href === href)).toBe(true);
    }
    expect(activeNavHref('/lessons-other', items)).toBe('');
    expect(pageTitle('/lessons')).toBe('Lessons');
    expect(pageTitle('/knowledge-bases/detail')).toBe('Knowledge bases');
  });
  it('separates authoring from connections and keeps account pages in the user menu', () => {
    expect(NAV_GROUPS.find((g) => g.label === 'Build')?.items.map((i) => i.href)).toEqual([
      '/library',
      '/agents',
      '/skills',
      '/review-presets',
    ]);
    expect(NAV_GROUPS.find((g) => g.label === 'Connect')?.items.map((i) => i.href)).toEqual([
      '/connections',
      '/models',
      '/mcp',
      '/bundles',
    ]);
    expect(USER_NAV_ITEMS.map((i) => i.href)).toEqual(['/settings', '/docs']);
    expect(navLabel('/review-presets')).toBe('Review presets');
    expect(navLabel('/admin/review-presets')).toBe('Platform review presets');
    expect(pageSection('/connections')).toBe('Connect');
  });
  it.each(NAV_ITEMS.map((i) => [i.href, i.minRole] as const))(
    '%s is offered to exactly the roles its layout admits',
    (href, minRole) => {
      // A nav entry looser than the layout bounces users off the page; a
      // stricter one hides a page they may use.
      expect(minRole).toBe(layoutFloor(href));
    }
  );

  it('has unique hrefs and labels', () => {
    expect(new Set(NAV_ITEMS.map((i) => i.href)).size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((i) => i.label)).size).toBe(NAV_ITEMS.length);
  });

  it('uses no trailing period in labels', () => {
    for (const item of NAV_ITEMS) {
      expect(item.label).not.toMatch(/\.$/);
    }
  });
});

describe('visibleNavGroups', () => {
  const hrefsFor = (role: string, scoped?: boolean) =>
    visibleNavGroups(role, scoped).flatMap((g) => flattenNavItems(g.items).map((i) => i.href));

  it('groups the sidebar into Work, Build, Connect, Knowledge and Admin', () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual([
      'Work',
      'Build',
      'Connect',
      'Knowledge',
      'Admin',
    ]);
  });

  it('shows an ENGINEER only ENGINEER pages', () => {
    const hrefs = hrefsFor('ENGINEER');
    expect(hrefs).toContain('/admin/automations');
    expect(hrefs).not.toContain('/admin/baselines');
    expect(hrefs).not.toContain('/admin/review-presets');
    expect(hrefs).toContain('/connections');
    expect(hrefs).toContain('/library');
    expect(hrefs).toContain('/knowledge');
    expect(hrefs).toContain('/lessons');
    expect(hrefs).not.toContain('/skills');
    expect(hrefs).not.toContain('/admin/users');
  });

  it('shows a LEAD the LEAD pages but not the ADMIN-only authoring pages', () => {
    const hrefs = hrefsFor('LEAD');
    expect(hrefs).toContain('/admin/baselines');
    expect(hrefs).toContain('/admin/organizations');
    expect(hrefs).not.toContain('/skills');
    expect(hrefs).not.toContain('/mcp');
    expect(hrefs).not.toContain('/admin/integrations');
  });

  it('offers LLM usage by usage scope, not by platform role', () => {
    const offered = (role: string, scoped?: boolean) =>
      hrefsFor(role, scoped).includes('/admin/usage');
    expect(offered('ENGINEER')).toBe(false);
    expect(offered('ENGINEER', true)).toBe(true);
    // A LEAD who leads no team has no scope, so the page would bounce them.
    expect(offered('LEAD')).toBe(false);
    expect(offered('LEAD', true)).toBe(true);
    expect(offered('ADMIN')).toBe(true);
  });

  it('shows an ADMIN everything', () => {
    expect(hrefsFor('ADMIN').length).toBe(NAV_ITEMS.length - USER_NAV_ITEMS.length);
  });

  it('shows nothing to an unknown role', () => {
    expect(visibleNavGroups(undefined)).toEqual([]);
  });

  it('gives Admin one sidebar entry, holding only the pages the role may open', () => {
    for (const role of ['ENGINEER', 'LEAD', 'ADMIN']) {
      const admin = visibleNavGroups(role, true).find((g) => g.label === 'Admin');
      expect(admin?.items.map((i) => i.href)).toEqual([ADMIN_HREF]);
      const children = admin?.items[0].children ?? [];
      expect(children.length).toBeGreaterThan(0);
      for (const child of children) {
        expect(hasRole(role, child.minRole), `${role} ${child.href}`).toBe(true);
        expect(child.href.startsWith(`${ADMIN_HREF}/`)).toBe(true);
      }
    }
  });

  it('drops an entry with children when none of them is visible', () => {
    // An unknown role sees no Admin page, so it gets no Admin entry either.
    expect(hrefsFor('NOPE')).not.toContain(ADMIN_HREF);
  });
});

describe('nav hrefs', () => {
  /** The URL of every `page.tsx` under the app directory, `[param]` segments kept. */
  function appRoutes(dir = APP_DIR, url = ''): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isFile()) {
        return entry.name === 'page.tsx' ? [url || '/'] : [];
      }
      return entry.isDirectory() ? appRoutes(join(dir, entry.name), `${url}/${entry.name}`) : [];
    });
  }

  it.each(NAV_ITEMS.map((i) => [i.href]))('%s resolves to a page in the app', (href) => {
    expect(appRoutes()).toContain(href);
  });

  it.each(NAV_ITEMS.flatMap((i) => i.alsoActiveFor ?? []).map((p) => [p]))(
    'the sub-area %s is a page in the app',
    (prefix) => {
      expect(appRoutes()).toContain(prefix);
    }
  );
});

describe('activeNavHref', () => {
  it('picks the most specific match', () => {
    expect(activeNavHref('/library/abc', NAV_ITEMS)).toBe('/library');
    expect(activeNavHref('/requests/xyz', NAV_ITEMS)).toBe('/requests');
    expect(activeNavHref('/admin/policies/decisions', NAV_ITEMS)).toBe('/admin/policies/decisions');
    expect(activeNavHref('/admin/policies', NAV_ITEMS)).toBe('/admin/policies');
    expect(activeNavHref('/', NAV_ITEMS)).toBe('/');
    expect(activeNavHref('/nowhere', NAV_ITEMS)).toBe('');
  });

  it('lights the one Admin entry for every Admin page among the sidebar items', () => {
    const sidebar = NAV_GROUPS.flatMap((g) => g.items);
    expect(activeNavHref('/admin', sidebar)).toBe(ADMIN_HREF);
    expect(activeNavHref('/admin/users', sidebar)).toBe(ADMIN_HREF);
    expect(activeNavHref('/admin/evals/runs/r1', sidebar)).toBe(ADMIN_HREF);
  });

  it('highlights All runs on a run page, Requests on an epic and Automations on a schedule', () => {
    expect(activeNavHref('/runs', NAV_ITEMS)).toBe('/runs');
    expect(activeNavHref('/runs/abc', NAV_ITEMS)).toBe('/runs');
    expect(activeNavHref('/epics/wf-1', NAV_ITEMS)).toBe('/requests');
    expect(activeNavHref('/admin/schedules', NAV_ITEMS)).toBe('/admin/automations');
  });

  it('knows the Start work path', () => {
    expect(isStartWorkPath('/start')).toBe(true);
    expect(isStartWorkPath('/startling')).toBe(false);
  });
});

describe('pageTitle', () => {
  it('matches the nav label for every nav destination', () => {
    for (const item of NAV_ITEMS) {
      expect(pageTitle(item.href)).toBe(item.label);
      expect(navLabel(item.href)).toBe(item.label);
    }
  });

  it('titles detail and extra pages', () => {
    expect(pageTitle('/runs/abc')).toBe('Run');
    expect(pageTitle('/no/such/page')).toBe('Page');
    expect(knownPageTitle('/no/such/page')).toBeNull();
    expect(pageTitle('/oauth/consent')).toBe('Authorize app');
    expect(pageSection('/docs')).toBe('Help');
    expect(pageTitle('/runs')).toBe('All runs');
    expect(pageTitle('/admin/teams/abc')).toBe('Teams');
    expect(pageTitle('/admin/policies/decisions')).toBe('Autonomy decisions');
    expect(pageTitle('/epics/wf-1')).toBe('Epics');
    expect(pageTitle('/docs/architecture')).toBe('Docs');
    expect(pageTitle('/library/tpl-1/diff')).toBe('Workflow library');
  });

  it('puts each page in its sidebar group for the breadcrumb', () => {
    expect(pageSection('/approvals')).toBe('Work');
    expect(pageSection('/requests/abc')).toBe('Work');
    expect(pageSection('/library/abc')).toBe('Build');
    expect(pageSection('/agents')).toBe('Build');
    expect(pageSection('/admin/users')).toBe('Admin');
    expect(pageSection('/admin/integrations')).toBe('Admin');
    expect(pageSection('/admin/slack-channels/abc')).toBe('Admin');
    expect(pageTitle('/admin/slack-channels/abc')).toBe('Slack channels');
    expect(pageSection('/lessons')).toBe('Knowledge');
    expect(pageSection('/knowledge')).toBe('Knowledge');
    expect(pageSection('/')).toBeNull();
  });

  it('throws for an href with no nav entry', () => {
    expect(() => navLabel('/nope')).toThrow();
  });
});

describe('navSections', () => {
  const adminPages = () =>
    visibleNavGroups('ADMIN', true)
      .flatMap((g) => g.items)
      .find((i) => i.href === ADMIN_HREF)?.children ?? [];

  it('groups the Admin pages into the decided sections, in order', () => {
    expect(navSections(adminPages()).map((s) => s.label)).toEqual([
      'Access',
      'Security',
      'Spend & insights',
      'Configuration',
      'Credentials',
      'Quality',
    ]);
  });

  it('gives every Admin page its own icon within a section', () => {
    for (const section of navSections(adminPages())) {
      const icons = section.items.map((i) => i.icon);
      expect(new Set(icons).size).toBe(icons.length);
    }
  });

  it('keeps every sidebar item out of a section, so the sidebar stays flat', () => {
    for (const item of NAV_GROUPS.flatMap((g) => g.items)) {
      expect(item.section).toBeUndefined();
    }
  });
});
