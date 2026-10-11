// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NAV_ITEMS } from '@/lib/navigation';
import { hasRole } from '@/lib/roles';
import { useAuthStore } from '@/stores/authStore';
import { resetNavigation } from '@/test/mockNavigation';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());
vi.mock('@/hooks/useApprovals', () => ({ useApprovalsCount: () => 0 }));
vi.mock('@/hooks/useAdmin', () => ({
  useUsageScopes: () => ({ data: { orgs: [], platform: true, teams: [] } }),
}));

import { Sidebar } from '@/components/layout/Sidebar';
import { buildTourSteps, TOUR_STEPS } from './tourSteps';

const ROLES = ['ENGINEER', 'LEAD', 'ADMIN'] as const;

beforeEach(() => {
  resetNavigation('', '/');
});
afterEach(cleanup);

describe('buildTourSteps', () => {
  it('gives an engineer the work steps and nothing from Studio or the restricted Govern pages', () => {
    const ids = buildTourSteps('ENGINEER').map((s) => s.id);
    expect(ids).toEqual([
      'sidebar',
      'start-work',
      'requests',
      'pull-requests',
      'approvals',
      'docs',
      'help-tips',
    ]);
    const anchors = buildTourSteps('ENGINEER').map((s) => s.anchor);
    expect(anchors.some((a) => a?.startsWith('nav:/studio'))).toBe(false);
    // Approvals lives under /govern but sits in the Work group for every role.
    expect(anchors.filter((a) => a?.startsWith('nav:/govern'))).toEqual(['nav:/govern/approvals']);
  });

  it('adds Platform settings for a lead, and Studio and Autonomy policies only for an admin', () => {
    const lead = buildTourSteps('LEAD').map((s) => s.id);
    expect(lead).toContain('platform-settings');
    expect(lead).not.toContain('agents');
    expect(lead).not.toContain('autonomy-policies');
    const admin = buildTourSteps('ADMIN').map((s) => s.id);
    expect(admin).toEqual(expect.arrayContaining(['platform-settings', 'agents', 'integrations']));
    expect(admin).toContain('autonomy-policies');
    expect(admin.length).toBeGreaterThan(lead.length);
  });

  it('describes epics in the Start work step only to roles that may start one', () => {
    const body = (role?: string) => buildTourSteps(role).find((s) => s.id === 'start-work')?.body;
    expect(body('ENGINEER')).not.toMatch(/epic/i);
    expect(body('ENGINEER')).toMatch(/agent/);
    expect(body(undefined)).not.toMatch(/epic/i);
    expect(body('LEAD')).toMatch(/epic/i);
    expect(body('ADMIN')).toMatch(/epic/i);
  });

  it('does not name sidebar sections a role may not see', () => {
    const body = buildTourSteps('ENGINEER').find((s) => s.id === 'sidebar')?.body;
    expect(body).not.toMatch(/Studio/);
  });

  it('treats an unknown or missing role as an engineer', () => {
    const engineer = buildTourSteps('ENGINEER');
    expect(buildTourSteps(undefined)).toEqual(engineer);
    expect(buildTourSteps('NOPE')).toEqual(engineer);
  });

  it('keeps ids unique and the tour short', () => {
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const role of ROLES) {
      expect(buildTourSteps(role).length).toBeLessThanOrEqual(12);
    }
    expect(buildTourSteps('ENGINEER').length).toBeGreaterThanOrEqual(5);
  });

  it('agrees with the navigation about who may open each page it points at', () => {
    for (const step of TOUR_STEPS) {
      const href = step.anchor?.startsWith('nav:') ? step.anchor.slice(4) : null;
      if (!href || href === '/start') {
        continue; // /start is the persistent button, open to every role
      }
      const item = NAV_ITEMS.find((i) => i.href === href);
      expect(item, `${step.id} anchors a page with no nav entry: ${href}`).toBeDefined();
      for (const role of ROLES) {
        expect(step.roles.includes(role), `${step.id} for ${role}`).toBe(
          hasRole(role, item?.minRole ?? 'ADMIN')
        );
      }
      // The title is the nav label verbatim.
      expect(step.title).toBe(item?.label);
    }
  });
});

describe('tour anchors exist in the real shell', () => {
  for (const role of ROLES) {
    it(`renders every anchor the ${role} tour points at`, () => {
      useAuthStore.setState({ user: { email: 'a@x.dev', role, sub: 'u1' } } as never);
      render(<Sidebar onClose={() => undefined} open />);
      const steps = buildTourSteps(role).filter((s) => s.anchor !== null);
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(
          document.querySelector(`[data-tour="${step.anchor}"]`),
          `${step.id} → data-tour="${step.anchor}"`
        ).not.toBeNull();
      }
    });
  }

  it('does not render an anchor for a page the role cannot open', () => {
    useAuthStore.setState({ user: { email: 'a@x.dev', role: 'ENGINEER', sub: 'u1' } } as never);
    render(<Sidebar onClose={() => undefined} open />);
    expect(document.querySelector('[data-tour="nav:/studio/agents/library"]')).toBeNull();
  });
});
