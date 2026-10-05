// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { resetNavigation } from '@/test/mockNavigation';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());
vi.mock('@/hooks/useApprovals', () => ({ useApprovalsCount: () => 0 }));
vi.mock('@/hooks/useAdmin', () => ({
  useUsageScopes: () => ({ data: { orgs: [], platform: true, teams: [] } }),
}));

import { Sidebar } from './Sidebar';

beforeEach(() => {
  window.localStorage.clear();
  useAuthStore.setState({ user: { email: 'a@x.dev', role: 'ADMIN', sub: 'u1' } } as never);
});
afterEach(cleanup);

describe('Sidebar govern sections', () => {
  it('starts every section open, so the pages inside are discoverable', () => {
    resetNavigation('', '/');
    render(<Sidebar onClose={() => undefined} open />);
    const toggles = screen.getAllByRole('button', { expanded: true });
    expect(toggles.length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('button', { expanded: false })).toHaveLength(0);
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
