// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { resetNavigation } from '@/test/mockNavigation';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());
vi.mock('@/hooks/useAdmin', () => ({
  useUsageScopes: () => ({ data: { orgs: [], platform: false, teams: [] } }),
}));

import { AdminNav } from './AdminNav';

const useRole = (role: 'ENGINEER' | 'LEAD' | 'ADMIN') =>
  useAuthStore.setState({ user: { email: 'a@x.dev', role, sub: 'u1' } } as never);

afterEach(cleanup);

function links() {
  const nav = screen.getByRole('navigation', { name: 'Admin' });
  return within(nav)
    .getAllByRole('link', { hidden: true })
    .map((a) => a.getAttribute('href'));
}

describe('AdminNav', () => {
  it('lists every Admin page for an ADMIN, by section', () => {
    useRole('ADMIN');
    resetNavigation('', '/admin/users');
    render(<AdminNav />);
    expect(links()).toEqual(expect.arrayContaining(['/admin', '/admin/users', '/admin/scanner']));
    for (const section of ['Access', 'Security', 'Configuration', 'Credentials', 'Knowledge']) {
      expect(screen.getByRole('list', { hidden: true, name: section })).toBeTruthy();
    }
  });

  it('keeps the role gating of the sidebar: an ENGINEER sees only ENGINEER pages', () => {
    useRole('ENGINEER');
    resetNavigation('', '/admin/teams');
    render(<AdminNav />);
    const hrefs = links();
    expect(hrefs).toContain('/admin/teams');
    expect(hrefs).toContain('/admin/automations');
    expect(hrefs).not.toContain('/admin/users');
    expect(hrefs).not.toContain('/admin/platform-settings');
    expect(hrefs).not.toContain('/admin/usage');
    expect(screen.queryByRole('list', { hidden: true, name: 'Security' })).toBeNull();
  });

  it('marks the current page, and the parent entry on a page without its own', () => {
    useRole('ADMIN');
    resetNavigation('', '/admin/schedules');
    render(<AdminNav />);
    const current = screen
      .getAllByRole('link', { hidden: true })
      .filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.getAttribute('href'))).toEqual(['/admin/automations']);
  });

  it('folds into a disclosure naming the current page on narrow screens', () => {
    useRole('ADMIN');
    resetNavigation('', '/admin/audit');
    render(<AdminNav />);
    const toggle = screen.getByRole('button', { name: /Admin.*Audit log/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const panel = document.getElementById(toggle.getAttribute('aria-controls') as string);
    expect(panel?.className).toContain('max-lg:hidden');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(panel?.className).not.toContain('max-lg:hidden');
  });
});
