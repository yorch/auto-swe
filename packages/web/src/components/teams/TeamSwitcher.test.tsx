// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetNavigation } from '@/test/mockNavigation';
import { TeamSwitcher } from './TeamSwitcher';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

const nav = vi.hoisted(() => ({
  entries: [] as {
    needsYou: number;
    team: { id: string; myRole: string | null; name: string; slug: string };
  }[],
}));
vi.mock('@/hooks/useTeamNav', () => ({
  useTeamNav: () => ({ entries: nav.entries, isLoading: false }),
}));

const prefs = vi.hoisted(() => ({ pinned: [] as string[], set: vi.fn() }));
vi.mock('@/hooks/useUserPreferences', () => ({
  useUserPreferences: () => ({
    pinnedTeamSlugs: prefs.pinned,
    setPinnedTeamSlugs: prefs.set,
  }),
}));

const entry = (slug: string, name: string, myRole: string | null, needsYou: number) => ({
  needsYou,
  team: { id: `id-${slug}`, myRole, name, slug },
});

beforeEach(() => {
  prefs.pinned = [];
  prefs.set.mockClear();
  resetNavigation('', '/');
  nav.entries = [
    entry('payments', 'Payments', 'LEAD', 3),
    entry('platform', 'Platform', 'ENGINEER', 0),
  ];
});
afterEach(cleanup);

function open(path = '/') {
  resetNavigation('', path);
  render(<TeamSwitcher />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch team' }));
  return within(screen.getByRole('list', { name: 'Teams' }));
}

describe('TeamSwitcher', () => {
  it('lists All my teams first, then the member teams with role and needs-you badges', () => {
    const menu = open();
    const rows = menu.getAllByRole('link');
    expect(rows.map((r) => r.getAttribute('href'))).toEqual([
      '/',
      '/teams/payments',
      '/teams/platform',
    ]);
    expect(rows[0]?.textContent).toContain('All my teams');
    expect(rows[1]?.textContent).toContain('Lead');
    expect(within(rows[1] as HTMLElement).getByTestId('needs-you-badge').textContent).toContain(
      '3'
    );
    // A team with nothing waiting shows no badge.
    expect(within(rows[2] as HTMLElement).queryByTestId('needs-you-badge')).toBeNull();
  });

  it('keeps the tab the caller is on when it moves to another team', () => {
    open('/teams/platform/work');
    expect(screen.getByRole('link', { name: /Payments/ }).getAttribute('href')).toBe(
      '/teams/payments/work'
    );
  });

  it('opens the overview from a page outside any team space', () => {
    open('/requests');
    expect(screen.getByRole('link', { name: /Payments/ }).getAttribute('href')).toBe(
      '/teams/payments'
    );
  });

  it('names the current team and marks it', () => {
    open('/teams/payments/members');
    expect(screen.getByRole('button', { name: 'Switch team' }).textContent).toContain('Payments');
    expect(screen.getByRole('link', { name: /Payments/ }).getAttribute('aria-current')).toBe(
      'page'
    );
  });

  it('closes on Escape', () => {
    open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('list', { name: 'Teams' })).toBeNull();
  });

  describe('pins', () => {
    it('pins a team without navigating, appending it after the existing pins', () => {
      prefs.pinned = ['platform'];
      const menu = open('/requests');
      fireEvent.click(menu.getByRole('button', { name: 'Pin Payments to the sidebar' }));
      expect(prefs.set).toHaveBeenCalledWith(['platform', 'payments']);
      expect(screen.getByRole('list', { name: 'Teams' })).toBeTruthy();
      expect(
        menu
          .getByRole('button', { name: 'Unpin Platform from the sidebar' })
          .getAttribute('aria-pressed')
      ).toBe('true');
      expect(
        menu
          .getByRole('button', { name: 'Pin Payments to the sidebar' })
          .getAttribute('aria-pressed')
      ).toBe('false');
    });

    it('unpins the last pin to an empty list, which the sidebar answers with its default', () => {
      prefs.pinned = ['payments'];
      const menu = open();
      fireEvent.click(menu.getByRole('button', { name: 'Unpin Payments from the sidebar' }));
      expect(prefs.set).toHaveBeenCalledWith([]);
    });

    it('drops pins of teams the caller has left when it changes the list', () => {
      prefs.pinned = ['gone', 'payments'];
      const menu = open();
      fireEvent.click(menu.getByRole('button', { name: 'Pin Platform to the sidebar' }));
      expect(prefs.set).toHaveBeenCalledWith(['payments', 'platform']);
    });

    it('keeps the pin control a separate button from the team link', () => {
      const menu = open();
      const link = menu.getByRole('link', { name: /Payments/ });
      expect(link.querySelector('button')).toBeNull();
    });

    it('refuses a 21st pin, saying why', () => {
      const many = Array.from({ length: 20 }, (_, i) => `team-${i}`);
      nav.entries = [
        ...many.map((slug) => entry(slug, slug, 'ENGINEER', 0)),
        entry('extra', 'Extra', 'LEAD', 0),
      ];
      prefs.pinned = many;
      const menu = open();
      const button = menu.getByRole('button', { name: 'Pin Extra to the sidebar' });
      expect(button.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(button);
      expect(prefs.set).not.toHaveBeenCalled();
    });
  });
});
