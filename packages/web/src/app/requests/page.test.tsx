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
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
const useRequests = vi.fn();
const useEpics = vi.fn();
vi.mock('@/hooks/useRequests', () => ({
  useRequests: (...args: unknown[]) => useRequests(...args),
}));
vi.mock('@/hooks/useEpics', () => ({ useEpics: (...args: unknown[]) => useEpics(...args) }));

import RequestsPage from './page';

const settled = { error: null, isError: false, isFetching: false, isLoading: false };
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
  vi.clearAllMocks();
});

describe('Requests page clear filters', () => {
  it('offers Clear filters once the scope or type moves off its default', () => {
    useRequests.mockReturnValue({ ...settled, data: { data: [], meta: { total: 0 } } });
    useEpics.mockReturnValue({ ...settled, data: undefined });
    nav.search = '';
    const first = render(<RequestsPage />);
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    first.unmount();
    nav.search = 'scope=TEAM';
    const second = render(<RequestsPage />);
    expect(screen.getAllByRole('button', { name: 'Clear filters' }).length).toBeGreaterThan(0);
    second.unmount();
    nav.search = 'type=epics';
    render(<RequestsPage />);
    expect(screen.getAllByRole('button', { name: 'Clear filters' }).length).toBeGreaterThan(0);
  });
});

describe('Requests page epics', () => {
  it('keeps the type filter without a redundant epics header link', () => {
    nav.search = '';
    useRequests.mockReturnValue({ ...settled, data: { data: [], meta: { total: 0 } } });
    useEpics.mockReturnValue({ ...settled, data: undefined });
    render(<RequestsPage />);
    expect(screen.queryByRole('link', { name: 'Multi-repo epics' })).toBeNull();
    expect(screen.getByRole('button', { name: /Request type/ })).toBeTruthy();
  });

  it('lists epics when the type filter is epics, and only queries epics', () => {
    nav.search = 'type=epics';
    useRequests.mockReturnValue({ ...settled, data: undefined });
    useEpics.mockReturnValue({
      ...settled,
      data: {
        data: [
          {
            createdAt: '2026-10-01T00:00:00Z',
            description: 'Rename the billing field everywhere',
            epicWorkflowId: 'epic-1',
            externalTicketId: 'EPIC-9',
            repoCount: 3,
            status: 'RUNNING',
            workRequestId: 'wr-1',
          },
        ],
        meta: { total: 1 },
      },
    });
    render(<RequestsPage />);
    expect(screen.getByText('EPIC-9')).toBeTruthy();
    expect(useRequests.mock.calls[0][1]).toEqual({ enabled: false });
    expect(useEpics.mock.calls[0][1]).toEqual({ enabled: true });
  });

  it('says what Needs attention covers, including merges and timeouts', () => {
    nav.search = '';
    useRequests.mockReturnValue({ ...settled, data: { data: [], meta: { total: 0 } } });
    useEpics.mockReturnValue({ ...settled, data: undefined });
    render(<RequestsPage />);
    expect(
      screen.getByText(/a person is needed \(a gate or a merge\), or a run failed or timed out/)
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /What is a request/ })).toBeTruthy();
  });
});

describe('Requests page team filter', () => {
  it('narrows requests and epics to the ?team= team and shows a removable chip', () => {
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
    useRequests.mockReturnValue({ ...settled, data: { data: [], meta: { total: 0 } } });
    useEpics.mockReturnValue({ ...settled, data: undefined });
    render(<RequestsPage />);
    expect(useRequests).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ teamId: 'team-1' })
    );
    expect(useEpics).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ teamId: 'team-1' })
    );
    expect(screen.getByTestId('team-chip').textContent).toContain('Payments');
    fireEvent.click(screen.getByRole('button', { name: 'Remove the Payments team filter' }));
    expect(teamParam.value.clear).toHaveBeenCalledTimes(1);
  });

  it('lists every team, with no chip, without ?team=', () => {
    nav.search = '';
    useRequests.mockReturnValue({ ...settled, data: { data: [], meta: { total: 0 } } });
    useEpics.mockReturnValue({ ...settled, data: undefined });
    render(<RequestsPage />);
    expect(useRequests.mock.calls[0]?.[1]).toMatchObject({ teamId: undefined });
    expect(screen.queryByTestId('team-chip')).toBeNull();
  });

  it('waits for the team to resolve rather than flash every team’s requests', () => {
    nav.search = 'team=payments';
    teamParam.value = { ...teamParam.value, blocked: true, pending: true, slug: 'payments' };
    useRequests.mockReturnValue({ ...settled, data: undefined });
    useEpics.mockReturnValue({ ...settled, data: undefined });
    render(<RequestsPage />);
    expect(useRequests.mock.calls[0]?.[1]).toMatchObject({ enabled: false });
    // The disabled query is not `isLoading`, so the page must not read it as an empty list.
    expect(screen.queryByText('No requests yet')).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('shows an error with a retry, not every team’s requests, when the team list failed', () => {
    nav.search = 'team=payments';
    const retry = vi.fn();
    teamParam.value = {
      ...teamParam.value,
      blocked: true,
      isError: true,
      retry,
      slug: 'payments',
    };
    useRequests.mockReturnValue({ ...settled, data: undefined });
    useEpics.mockReturnValue({ ...settled, data: undefined });
    render(<RequestsPage />);
    expect(useRequests.mock.calls[0]?.[1]).toMatchObject({ enabled: false });
    expect(screen.queryByText('No requests yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
