// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  // Some runtimes leave jsdom without Storage (Node's own localStorage global can shadow it); the
  // sidebar treats storage as optional, so the tests must not assume it either.
  try {
    window.localStorage?.clear();
  } catch {
    // No storage: nothing remembered to reset.
  }
  useAuthStore.setState({ user: { email: 'a@x.dev', role: 'ADMIN', sub: 'u1' } } as never);
});
afterEach(cleanup);

describe('Sidebar govern sections', () => {
  it('starts every section open, so the pages inside are discoverable', () => {
    resetNavigation('', '/');
    render(<Sidebar onClose={() => undefined} open />);
    // The user menu trigger is also a disclosure; only the section toggles control a nav panel.
    const sections = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-controls')?.startsWith('nav-section-'));
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.every((b) => b.getAttribute('aria-expanded') === 'true')).toBe(true);
  });

  it('collapses on click, naming the panel it controls', () => {
    resetNavigation('', '/');
    render(<Sidebar onClose={() => undefined} open />);
    const toggle = screen.getAllByRole('button', { expanded: true })[0];
    const panelId = toggle.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId as string)).not.toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the section holding the current page open and focusable, marked aria-disabled', () => {
    resetNavigation('', '/govern/scanner');
    render(<Sidebar onClose={() => undefined} open />);
    const holder = screen
      .getAllByRole('button', { expanded: true })
      .find((b) => b.getAttribute('aria-disabled') === 'true');
    expect(holder).toBeTruthy();
    expect((holder as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(holder as HTMLElement);
    expect(holder?.getAttribute('aria-expanded')).toBe('true');
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

  it('has no Studio anchor for an ENGINEER, and one for an ADMIN', () => {
    useRole('ENGINEER');
    resetNavigation('', '/');
    const { container } = render(<Sidebar onClose={() => undefined} open />);
    expect(container.querySelector('[data-tour="nav:/studio/agents/library"]')).toBeNull();
    useRole('ADMIN');
    cleanup();
    const admin = render(<Sidebar onClose={() => undefined} open />);
    expect(
      admin.container.querySelector('[data-tour="nav:/studio/agents/library"]')
    ).not.toBeNull();
  });

  it('removes a collapsed section and its links, so their anchors are absent until reopened', () => {
    useRole('ADMIN');
    resetNavigation('', '/');
    const { container } = render(<Sidebar onClose={() => undefined} open />);
    const access = screen.getByRole('button', { name: 'Access' });
    expect(container.querySelector('[data-tour="nav:/govern/users"]')).not.toBeNull();
    fireEvent.click(access);
    expect(access.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-tour="nav:/govern/users"]')).toBeNull();
    fireEvent.click(access);
    expect(container.querySelector('[data-tour="nav:/govern/users"]')).not.toBeNull();
  });

  it('keeps the section holding the current page open, so its anchors stay present', () => {
    useRole('ADMIN');
    resetNavigation('', '/govern/users');
    const { container } = render(<Sidebar onClose={() => undefined} open />);
    const access = screen.getByRole('button', { name: 'Access' });
    fireEvent.click(access);
    expect(access.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-tour="nav:/govern/users"]')).not.toBeNull();
  });
});
