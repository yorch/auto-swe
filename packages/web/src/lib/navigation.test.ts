import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@auto-swe/shared';
import { describe, expect, it } from 'vitest';
import { activeNavHref, NAV_ITEMS, navLabel, pageTitle, visibleNavGroups } from './navigation';

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
  it('shows an ENGINEER only ENGINEER pages', () => {
    const hrefs = visibleNavGroups('ENGINEER').flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).toContain('/govern/schedules');
    expect(hrefs).not.toContain('/govern/baselines');
    expect(hrefs).toContain('/connections');
    expect(hrefs).not.toContain('/studio/skills');
    expect(hrefs).not.toContain('/govern/users');
  });

  it('shows a LEAD the LEAD pages but not the ADMIN-only studio', () => {
    const hrefs = visibleNavGroups('LEAD').flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).toContain('/govern/baselines');
    expect(hrefs).toContain('/govern/budgets');
    expect(hrefs).not.toContain('/studio/skills');
    expect(hrefs).not.toContain('/studio/mcp');
    expect(visibleNavGroups('LEAD').map((g) => g.label)).not.toContain('Studio');
  });

  it('shows an ADMIN everything', () => {
    const count = visibleNavGroups('ADMIN').flatMap((g) => g.items).length;
    expect(count).toBe(NAV_ITEMS.length);
  });

  it('shows nothing to an unknown role', () => {
    expect(visibleNavGroups(undefined)).toEqual([]);
  });
});

describe('activeNavHref', () => {
  it('picks the most specific match', () => {
    expect(activeNavHref('/workflows/library/abc', NAV_ITEMS)).toBe('/workflows/library');
    expect(activeNavHref('/workflows/xyz', NAV_ITEMS)).toBe('/workflows');
    expect(activeNavHref('/', NAV_ITEMS)).toBe('/');
    expect(activeNavHref('/nowhere', NAV_ITEMS)).toBe('');
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
    expect(pageTitle('/runs')).toBe('Runs');
    expect(pageTitle('/govern/teams/abc')).toBe('Teams');
    expect(pageTitle('/govern/policies/decisions')).toBe('Autonomy decisions');
    expect(pageTitle('/epics/wf-1')).toBe('Epics');
    expect(pageTitle('/docs/architecture')).toBe('Docs');
  });

  it('throws for an href with no nav entry', () => {
    expect(() => navLabel('/nope')).toThrow();
  });
});
