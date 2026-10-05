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
