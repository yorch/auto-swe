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

    expect((screen.getByLabelText('Team') as HTMLSelectElement).value).toBe('team-1');
    expect(screen.getByRole('option', { name: 'Platform' })).toBeTruthy();
    expect(vi.mocked(useQuery).mock.calls.at(-1)?.[0].queryKey).toContain('team-1');
    fireEvent.change(screen.getByLabelText('Team'), { target: { value: '' } });
    expect(update).toHaveBeenCalledWith({ teamId: null });
  });
});
