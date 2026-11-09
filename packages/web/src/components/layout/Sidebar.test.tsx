// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { visibleNavGroups } from '@/lib/navigation';
import { useAuthStore } from '@/stores/authStore';
import { resetNavigation } from '@/test/mockNavigation';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());
vi.mock('@/hooks/useApprovals', () => ({ useApprovalsCount: () => 0 }));
const teamNav = vi.hoisted(() => ({
  entries: [] as {
    needsYou: number;
    team: { id: string; myRole: string; name: string; slug: string };
  }[],
  pinned: [] as string[],
}));
vi.mock('@/hooks/useTeamNav', () => ({
  useTeamNav: () => ({ entries: teamNav.entries, isLoading: false }),
}));
vi.mock('@/hooks/useUserPreferences', () => ({
  useUserPreferences: () => ({ pinnedTeamSlugs: teamNav.pinned }),
}));
vi.mock('@/hooks/useAdmin', () => ({
  useUsageScopes: () => ({ data: { orgs: [], platform: true, teams: [] } }),
}));

import { Sidebar } from './Sidebar';

beforeEach(() => {
  useAuthStore.setState({ user: { email: 'a@x.dev', role: 'ADMIN', sub: 'u1' } } as never);
});
afterEach(cleanup);

describe('Sidebar structure', () => {
  it('shows the Work and Build groups and one Admin entry, not the Admin pages', () => {
    resetNavigation('', '/');
    const { container } = render(<Sidebar onClose={() => undefined} open />);
    const nav = container.querySelector('nav') as HTMLElement;
    expect(nav.textContent).toContain('Work');
    expect(nav.textContent).toContain('Build');
    const hrefs = Array.from(nav.querySelectorAll('a[href]')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/admin');
    expect(hrefs.filter((h) => h?.startsWith('/admin/'))).toEqual([]);
    // No collapsible sections remain in the sidebar itself.
    expect(container.querySelector('[aria-controls^="nav-section-"]')).toBeNull();
  });

  it.each(['/admin', '/admin/users', '/admin/evals/runs/r1'])(
    'marks the Admin entry as the current page on %s',
    (path) => {
      resetNavigation('', path);
      render(<Sidebar onClose={() => undefined} open />);
      const admin = screen.getByRole('link', { name: 'Admin' });
      expect(admin.getAttribute('aria-current')).toBe('page');
    }
  );

  it('marks Requests current on a request and Workflow library on a template', () => {
    resetNavigation('', '/requests/abc');
    render(<Sidebar onClose={() => undefined} open />);
    expect(screen.getByRole('link', { name: 'Requests' }).getAttribute('aria-current')).toBe(
      'page'
    );
    cleanup();
    resetNavigation('', '/library/tpl-1/diff');
    render(<Sidebar onClose={() => undefined} open />);
    expect(
      screen.getByRole('link', { name: 'Workflow library' }).getAttribute('aria-current')
    ).toBe('page');
  });
});

describe('Sidebar data-tour anchors', () => {
  const setRole = (role: 'ENGINEER' | 'LEAD' | 'ADMIN') =>
    useAuthStore.setState({ user: { email: 'a@x.dev', role, sub: 'u1' } } as never);

  it.each(['ENGINEER', 'LEAD', 'ADMIN'] as const)(
    'gives the sidebar container its anchor and every rendered %s nav link its own href',
    (role) => {
      setRole(role);
      resetNavigation('', '/');
      const { container } = render(<Sidebar onClose={() => undefined} open />);
      expect(container.querySelector('aside')?.getAttribute('data-tour')).toBe('sidebar');
      const nav = container.querySelector('nav') as HTMLElement;
      const links = Array.from(nav.querySelectorAll('a[href]'));
      expect(links.length).toBeGreaterThan(1);
      for (const link of links) {
        expect(link.getAttribute('data-tour')).toBe(`nav:${link.getAttribute('href')}`);
      }
    }
  );

  it.each(['ENGINEER', 'LEAD', 'ADMIN'] as const)(
    'anchors exactly the items the %s role may open, plus Start work',
    (role) => {
      setRole(role);
      resetNavigation('', '/');
      const { container } = render(<Sidebar onClose={() => undefined} open />);
      // The usage-scope check is mocked as platform-wide, matching useVisibleNavGroups.
      const expected = visibleNavGroups(role, true).flatMap((g) => g.items.map((i) => i.href));
      const anchored = Array.from(container.querySelectorAll('[data-tour^="nav:"]')).map((el) =>
        el.getAttribute('data-tour')
      );
      expect(anchored.sort()).toEqual(['nav:/start', ...expected.map((h) => `nav:${h}`)].sort());
    }
  );

  describe('support footer', () => {
    afterEach(() => {
      (window as unknown as { __APP_CONFIG__?: unknown }).__APP_CONFIG__ = undefined;
    });

    it('shows the configured support contact after the navigation', () => {
      (window as unknown as { __APP_CONFIG__?: unknown }).__APP_CONFIG__ = {
        support: { email: 'help@example.com' },
      };
      resetNavigation('', '/');
      const { container } = render(<Sidebar onClose={() => undefined} open />);
      const support = screen.getByRole('group', { name: 'Support' });
      expect(support.textContent).toContain('help@example.com');
      const nav = container.querySelector('nav') as HTMLElement;
      expect(nav.contains(support)).toBe(false);
      expect(nav.compareDocumentPosition(support) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('adds no support element or heading when nothing is configured', () => {
      resetNavigation('', '/');
      const { container } = render(<Sidebar onClose={() => undefined} open />);
      expect(screen.queryByRole('group', { name: 'Support' })).toBeNull();
      expect(screen.queryByText('Support')).toBeNull();
      // The nav stays the last child: no empty footer container follows it.
      expect(container.querySelector('aside')?.lastElementChild?.tagName).toBe('NAV');
    });
  });

  it('has no Agents anchor for an ENGINEER, and one for an ADMIN', () => {
    setRole('ENGINEER');
    resetNavigation('', '/');
    const { container } = render(<Sidebar onClose={() => undefined} open />);
    expect(container.querySelector('[data-tour="nav:/agents"]')).toBeNull();
    setRole('ADMIN');
    cleanup();
    const admin = render(<Sidebar onClose={() => undefined} open />);
    expect(admin.container.querySelector('[data-tour="nav:/agents"]')).not.toBeNull();
  });
});

describe('Sidebar Teams group', () => {
  const entry = (slug: string, name: string, needsYou = 0) => ({
    needsYou,
    team: { id: `id-${slug}`, myRole: 'ENGINEER', name, slug },
  });

  beforeEach(() => {
    teamNav.entries = [];
    teamNav.pinned = [];
  });

  it('lists every member team with its needs-you badge when none is pinned', () => {
    teamNav.entries = [entry('payments', 'Payments', 4), entry('platform', 'Platform')];
    resetNavigation('', '/');
    render(<Sidebar onClose={() => undefined} open />);
    const group = screen.getByRole('list', { name: 'Teams' });
    const links = Array.from(group.querySelectorAll('a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/teams/payments',
      '/teams/platform',
    ]);
    expect(links[0]?.textContent).toContain('4');
    expect(links[1]?.querySelector('[data-testid="needs-you-badge"]')).toBeNull();
  });

  it('lists only the pinned teams, in pin order', () => {
    teamNav.entries = [entry('a', 'Alpha'), entry('b', 'Beta'), entry('c', 'Gamma')];
    teamNav.pinned = ['c', 'a', 'gone'];
    resetNavigation('', '/');
    render(<Sidebar onClose={() => undefined} open />);
    const links = Array.from(screen.getByRole('list', { name: 'Teams' }).querySelectorAll('a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/teams/c', '/teams/a']);
  });

  it('shows at most eight teams when nothing is pinned', () => {
    teamNav.entries = Array.from({ length: 11 }, (_, i) => entry(`t${i}`, `Team ${i}`));
    resetNavigation('', '/');
    render(<Sidebar onClose={() => undefined} open />);
    expect(screen.getByRole('list', { name: 'Teams' }).querySelectorAll('a')).toHaveLength(8);
  });

  it('marks the team whose space is open', () => {
    teamNav.entries = [entry('payments', 'Payments')];
    resetNavigation('', '/teams/payments/work');
    render(<Sidebar onClose={() => undefined} open />);
    expect(screen.getByRole('link', { name: 'Payments' }).getAttribute('aria-current')).toBe(
      'page'
    );
  });

  it('has no Teams group for someone in no team', () => {
    resetNavigation('', '/');
    render(<Sidebar onClose={() => undefined} open />);
    expect(screen.queryByRole('list', { name: 'Teams' })).toBeNull();
  });
});
