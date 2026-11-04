// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ replace: vi.fn(), search: '' }));
vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));
vi.mock('next/navigation', () => ({
  usePathname: () => '/tickets',
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
const useTickets = vi.fn();
vi.mock('@/hooks/useWorkViews', () => ({
  useTickets: (...args: unknown[]) => useTickets(...args),
}));

import TicketsPage from './page';

const settled = { error: null, isError: false, isFetching: false, isLoading: false };
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Tickets page', () => {
  it('hides automated runs by default, in an unticked "Include" box', () => {
    nav.search = '';
    useTickets.mockReturnValue({ ...settled, data: [], meta: { total: 0 } });
    render(<TicketsPage />);
    expect(useTickets).toHaveBeenCalledWith(
      expect.objectContaining({ includeAutomated: false, scope: 'MINE' })
    );
    expect(
      (screen.getByRole('checkbox', { name: 'Include automated runs' }) as HTMLInputElement).checked
    ).toBe(false);
  });

  it('includes them when the address asks, and unticking writes that to the address', () => {
    nav.search = 'automated=1&scope=TEAM&search=ABC';
    useTickets.mockReturnValue({ ...settled, data: [], meta: { total: 0 } });
    render(<TicketsPage />);
    expect(useTickets).toHaveBeenCalledWith(
      expect.objectContaining({ includeAutomated: true, scope: 'TEAM', search: 'ABC' })
    );
    const box = screen.getByRole('checkbox', { name: 'Include automated runs' });
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(box);
    expect(nav.replace).toHaveBeenCalledWith('/tickets?scope=TEAM&search=ABC', { scroll: false });
  });

  it('includes automated runs by setting the parameter, and hides them by dropping it', () => {
    nav.search = '';
    useTickets.mockReturnValue({ ...settled, data: [], meta: { total: 0 } });
    render(<TicketsPage />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include automated runs' }));
    expect(nav.replace).toHaveBeenCalledWith('/tickets?automated=1', { scroll: false });
  });

  it('explains a ticket id honestly and says what automated runs are, on demand', () => {
    nav.search = '';
    useTickets.mockReturnValue({ ...settled, data: [], meta: { total: 0 } });
    render(<TicketsPage />);
    expect(screen.getByText(/the label work is filed under/)).toBeTruthy();
    expect(screen.queryByText(/come from the issue tracker/)).toBeNull();
    expect(screen.getByRole('button', { name: 'About Automated runs' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mine' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'My team' })).toBeTruthy();
  });

  it('does not tell a reader to "try another search" when nothing was searched for', () => {
    nav.search = 'automated=1';
    useTickets.mockReturnValue({ ...settled, data: [], meta: { total: 0 } });
    render(<TicketsPage />);
    expect(screen.queryByText('Try another search.')).toBeNull();
    expect(screen.getByText('No tickets yet')).toBeTruthy();
  });
});
