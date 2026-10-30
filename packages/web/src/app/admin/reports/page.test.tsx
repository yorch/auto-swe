// @vitest-environment jsdom

import { useQuery } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import ReportsPage from './page';

const { filters, update, useTeamsMock } = vi.hoisted(() => ({
  filters: { search: 'tab=budget' },
  update: vi.fn(),
  useTeamsMock: vi.fn(),
}));
vi.mock('@tanstack/react-query', () => ({ useQuery: vi.fn() }));
vi.mock('@/hooks/useUrlFilters', () => ({
  useUrlFilters: () => ({ params: new URLSearchParams(filters.search), update }),
}));
vi.mock('@/hooks/useTeams', () => ({ useTeams: useTeamsMock }));

describe('ReportsPage', () => {
  beforeEach(() => {
    filters.search = 'tab=budget';
    update.mockReset();
    useTeamsMock.mockReturnValue({ data: [] });
    vi.mocked(useQuery).mockClear();
    vi.mocked(useQuery).mockReturnValue({
      error: new ApiError('forbidden', 403, null),
      isError: true,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    } as never);
  });

  it('shows the org-admin empty state for a budget 403', () => {
    render(<ReportsPage />);

    expect(screen.getByText('Budget forecasts need org admin access')).toBeTruthy();
  });

  it('shows the team selector and includes the selected team in the report query key', () => {
    filters.search = 'tab=delivery&teamId=team-1';
    useTeamsMock.mockReturnValue({
      data: [{ id: 'team-1', name: 'Platform' }],
    });
    vi.mocked(useQuery).mockReturnValue({
      data: {
        byRepo: [],
        byTeam: [],
        byTemplate: [],
        costPerMergedPr: null,
        medianTimeToMergeMs: null,
        prsCiPassed: 0,
        prsMerged: 0,
        runsStarted: 0,
        runsSucceeded: 0,
        runsWithPr: 0,
        spendUsd: 0,
      },
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    } as never);

    render(<ReportsPage />);

    const trigger = screen.getByRole('button', { name: /team/i });
    expect(trigger.textContent).toContain('Platform');
    expect(vi.mocked(useQuery).mock.calls.at(-1)?.[0].queryKey).toContain('team-1');
    fireEvent.click(trigger);
    expect(screen.getByRole('option', { name: 'Platform' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'All visible teams' }));
    expect(update).toHaveBeenCalledWith({ teamId: null });
  });

  it('marks the tab the URL names as selected, and exposes it as a tabpanel', () => {
    filters.search = 'tab=quality';
    render(<ReportsPage />);

    expect(screen.getByRole('tab', { name: 'Quality' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Delivery' }).getAttribute('aria-selected')).toBe(
      'false'
    );
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(
      'reports-tab-quality'
    );
  });
});
