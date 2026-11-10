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

const entry = (slug: string, name: string, myRole: string | null, needsYou: number) => ({
  needsYou,
  team: { id: `id-${slug}`, myRole, name, slug },
});

beforeEach(() => {
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
  it('lists My desk first, then the member teams with role and needs-you badges', () => {
    const menu = open();
    const rows = menu.getAllByRole('link');
    expect(rows.map((r) => r.getAttribute('href'))).toEqual([
      '/',
      '/teams/payments',
      '/teams/platform',
    ]);
    expect(rows[0]?.textContent).toContain('My desk');
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
});
