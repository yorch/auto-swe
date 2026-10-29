// @vitest-environment jsdom

import { useQuery } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import ReportsPage from './page';

vi.mock('@tanstack/react-query', () => ({ useQuery: vi.fn() }));
vi.mock('@/hooks/useUrlFilters', () => ({
  useUrlFilters: () => ({ params: new URLSearchParams('tab=budget'), update: vi.fn() }),
}));

describe('ReportsPage', () => {
  beforeEach(() => {
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
});
