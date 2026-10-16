// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { visibleNavGroups } from '@/lib/navigation';
import { useAuthStore } from '@/stores/authStore';
import { resetNavigation } from '@/test/mockNavigation';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());
vi.mock('@/hooks/useApprovals', () => ({ useApprovalsCount: () => 0 }));
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
  const useRole = (role: 'ENGINEER' | 'LEAD' | 'ADMIN') =>
    useAuthStore.setState({ user: { email: 'a@x.dev', role, sub: 'u1' } } as never);

  it.each(['ENGINEER', 'LEAD', 'ADMIN'] as const)(
    'gives the sidebar container its anchor and every rendered %s nav link its own href',
    (role) => {
      useRole(role);
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
      useRole(role);
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

  it('has no Agents anchor for an ENGINEER, and one for an ADMIN', () => {
    useRole('ENGINEER');
    resetNavigation('', '/');
    const { container } = render(<Sidebar onClose={() => undefined} open />);
    expect(container.querySelector('[data-tour="nav:/agents"]')).toBeNull();
    useRole('ADMIN');
    cleanup();
    const admin = render(<Sidebar onClose={() => undefined} open />);
    expect(admin.container.querySelector('[data-tour="nav:/agents"]')).not.toBeNull();
  });
});
