// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const teamParam = vi.hoisted(() => ({
  value: {
    blocked: false,
    clear: vi.fn(),
    isError: false,
    pending: false,
    retry: vi.fn(),
    slug: '',
    team: null as { name: string } | null,
    teamId: undefined as string | undefined,
  },
}));
vi.mock('@/hooks/useTeamParam', () => ({ useTeamParam: () => teamParam.value }));

const nav = vi.hoisted(() => ({ search: '' }));
vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));
vi.mock('next/navigation', () => ({
  usePathname: () => '/epics',
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
const useEpics = vi.fn();
vi.mock('@/hooks/useEpics', () => ({
  useEpics: (...args: unknown[]) => useEpics(...args),
}));
vi.mock('@/hooks/useTeams', () => ({ useLeadsATeam: () => true }));

import EpicsPage from './page';

const settled = {
  error: null,
  isError: false,
  isFetching: false,
  isLoading: false,
  refetch: vi.fn(),
};

afterEach(() => {
  teamParam.value = {
    blocked: false,
    clear: vi.fn(),
    isError: false,
    pending: false,
    retry: vi.fn(),
    slug: '',
    team: null,
    teamId: undefined,
  };
  cleanup();
  useEpics.mockReset();
  nav.search = '';
});

describe('Epics page', () => {
  it('defines an epic in the subtitle and promises a pull request, not a draft', () => {
    useEpics.mockReturnValue({ ...settled, data: { data: [], meta: { total: 0 } } });
    render(<EpicsPage />);
    expect(screen.getByText(/is a change that spans several repositories/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /What is an epic/ })).toBeTruthy();
    expect(screen.getByText(/each ending in its own pull request for you to review/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/draft/i);
  });

  it('asks for one page at a time, scoped from the address', () => {
    nav.search = 'scope=TEAM&offset=30';
    useEpics.mockReturnValue({ ...settled, data: { data: [], meta: { total: 0 } } });
    render(<EpicsPage />);
    expect(useEpics).toHaveBeenCalledWith(
      { limit: 30, offset: 30, scope: 'TEAM' },
      expect.anything()
    );
  });

  it('defaults to the team scope, as the gateway does', () => {
    useEpics.mockReturnValue({ ...settled, data: { data: [], meta: { total: 0 } } });
    render(<EpicsPage />);
    expect(useEpics).toHaveBeenCalledWith(
      { limit: 30, offset: 0, scope: 'TEAM' },
      expect.anything()
    );
  });

  it('points a Mine view with no epics at the team view', () => {
    nav.search = 'scope=MINE';
    useEpics.mockReturnValue({ ...settled, data: { data: [], meta: { total: 0 } } });
    render(<EpicsPage />);
    expect(screen.getByText('None of your epics yet')).toBeTruthy();
    expect(screen.getByText(/Switch to “My team”/)).toBeTruthy();
  });

  it('shows a Mine / My team scope control', () => {
    useEpics.mockReturnValue({ ...settled, data: { data: [], meta: { total: 0 } } });
    render(<EpicsPage />);
    expect(screen.getByRole('button', { name: 'Mine' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'My team' })).toBeTruthy();
  });
});

describe('Epics page team filter', () => {
  it('narrows the list to the ?team= team and shows a removable chip', () => {
    const clear = vi.fn();
    teamParam.value = {
      blocked: false,
      clear,
      isError: false,
      pending: false,
      retry: vi.fn(),
      slug: 'payments',
      team: { name: 'Payments' },
      teamId: 'team-1',
    };
    nav.search = 'team=payments';
    useEpics.mockReturnValue({ ...settled, data: { data: [], meta: { total: 0 } } });
    render(<EpicsPage />);
    expect(useEpics).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ teamId: 'team-1' })
    );
    expect(screen.getByTestId('team-chip').textContent).toContain('Payments');
    fireEvent.click(screen.getByRole('button', { name: 'Remove the Payments team filter' }));
    expect(teamParam.value.clear).toHaveBeenCalledTimes(1);
  });
});
