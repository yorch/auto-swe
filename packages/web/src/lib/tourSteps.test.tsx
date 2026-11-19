// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NAV_ITEMS } from '@/lib/navigation';
import { resetNavigation } from '@/test/mockNavigation';
import {
  ADMIN_PERMISSIONS,
  NO_PERMISSIONS,
  permissionsFor,
  resetPermissions,
  setPermissions,
} from '@/test/permissions';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());
vi.mock('@/hooks/useApprovals', () => ({ useApprovalsCount: () => 0 }));
vi.mock('@/hooks/useTeamNav', () => ({ useTeamNav: () => ({ entries: [], isLoading: false }) }));
vi.mock('@/hooks/useUserPreferences', () => ({
  useUserPreferences: () => ({ pinnedTeamSlugs: [] }),
}));
vi.mock('@/hooks/useEffectivePermissions', async () =>
  (await import('@/test/permissions')).permissionsMock()
);
vi.mock('@/hooks/useAdmin', () => ({
  useUsageScopes: () => ({ data: { orgs: [], platform: true, teams: [] } }),
}));

import { Sidebar } from '@/components/layout/Sidebar';
import { buildTourSteps, TOUR_STEPS } from './tourSteps';

const MEMBER = { platformAdmin: false, teamLead: false };
const LEAD = { platformAdmin: false, teamLead: true };
const ADMIN = { platformAdmin: true, teamLead: false };
const AUDIENCES = { admin: ADMIN, lead: LEAD, member: MEMBER } as const;
const PERMISSIONS = {
  admin: ADMIN_PERMISSIONS,
  lead: permissionsFor({
    teams: [{ capabilities: ['team.launch.multi-repo'], role: 'LEAD', teamId: 't1' }],
  }),
  member: NO_PERMISSIONS,
} as const;

beforeEach(() => {
  resetNavigation('', '/');
  resetPermissions();
});
afterEach(cleanup);

describe('buildTourSteps', () => {
  it('gives a member the work steps, the library and the Admin entry, but no platform-admin page', () => {
    const ids = buildTourSteps(MEMBER).map((s) => s.id);
    expect(ids).toEqual([
      'sidebar',
      'start-work',
      'approvals',
      'requests',
      'pull-requests',
      'workflow-library',
      'admin',
      'docs',
      'help-tips',
    ]);
    const anchors = buildTourSteps(MEMBER).map((s) => s.anchor);
    expect(anchors).not.toContain('nav:/agents');
    // Admin pages are reached through the one Admin entry, never pointed at one by one.
    expect(anchors.filter((a) => a?.startsWith('nav:/admin'))).toEqual(['nav:/admin']);
  });

  it('adds Agents only for an admin, and words the Admin step for each audience', () => {
    const lead = buildTourSteps(LEAD);
    expect(lead.map((s) => s.id)).not.toContain('agents');
    const admin = buildTourSteps(ADMIN);
    expect(admin.map((s) => s.id)).toContain('agents');
    expect(admin.length).toBeGreaterThan(lead.length);
    const adminBody = (steps: typeof admin) => steps.find((s) => s.id === 'admin')?.body;
    expect(adminBody(buildTourSteps(MEMBER))).not.toMatch(/platform settings/i);
    expect(adminBody(lead)).toMatch(/platform settings/i);
    expect(adminBody(lead)).not.toMatch(/integration/i);
    expect(adminBody(admin)).toMatch(/integration/i);
  });

  it('describes epics in the Start work step only to people who may start one', () => {
    const body = (audience: typeof MEMBER) =>
      buildTourSteps(audience).find((s) => s.id === 'start-work')?.body;
    expect(body(MEMBER)).not.toMatch(/epic/i);
    expect(body(MEMBER)).toMatch(/agent/);
    expect(body(LEAD)).toMatch(/epic/i);
    expect(body(ADMIN)).toMatch(/epic/i);
  });

  it('does not name sidebar sections a member may not see', () => {
    const body = buildTourSteps(MEMBER).find((s) => s.id === 'sidebar')?.body;
    expect(body).not.toMatch(/Studio|Govern/);
  });

  it('keeps ids unique and the tour short', () => {
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const audience of Object.values(AUDIENCES)) {
      expect(buildTourSteps(audience).length).toBeLessThanOrEqual(12);
    }
    expect(buildTourSteps(MEMBER).length).toBeGreaterThanOrEqual(5);
  });

  it('agrees with the navigation about who may open each page it points at', () => {
    for (const step of TOUR_STEPS) {
      const href = step.anchor?.startsWith('nav:') ? step.anchor.slice(4) : null;
      if (!href || href === '/start') {
        continue; // /start is the persistent button, open to everyone
      }
      const item = NAV_ITEMS.find((i) => i.href === href);
      expect(item, `${step.id} anchors a page with no nav entry: ${href}`).toBeDefined();
      // A step is for platform admins exactly when its page is.
      expect(step.adminOnly === true, step.id).toBe(item?.access === 'platform-admin');
      // The title is the nav label verbatim.
      expect(step.title).toBe(item?.label);
    }
  });
});

describe('tour anchors exist in the real shell', () => {
  for (const who of ['member', 'lead', 'admin'] as const) {
    it(`renders every anchor the ${who} tour points at`, () => {
      setPermissions(PERMISSIONS[who]);
      render(<Sidebar onClose={() => undefined} open />);
      const steps = buildTourSteps(AUDIENCES[who]).filter((s) => s.anchor !== null);
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(
          document.querySelector(`[data-tour="${step.anchor}"]`),
          `${step.id} → data-tour="${step.anchor}"`
        ).not.toBeNull();
      }
    });
  }

  it('does not render an anchor for a page the person cannot open', () => {
    setPermissions(NO_PERMISSIONS);
    render(<Sidebar onClose={() => undefined} open />);
    expect(document.querySelector('[data-tour="nav:/agents"]')).toBeNull();
  });
});
