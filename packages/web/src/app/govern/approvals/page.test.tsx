// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const steps = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@/hooks/useApprovals', () => ({
  useApprovals: () => ({
    data: steps.rows,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/components/approvals/HumanStepCard', () => ({ HumanStepCard: () => null }));

import GovernApprovalsPage from './page';

describe('approvals page cap label', () => {
  it('says so when the All tab hit the server cap', () => {
    steps.rows = Array.from({ length: 200 }, (_, i) => ({ id: String(i) }));
    render(<GovernApprovalsPage />);
    fireEvent.click(screen.getByText('All'));
    expect(screen.getByText(/Showing 200 steps, the most this list loads/)).toBeTruthy();
  });

  it('shows a plain total below the cap', () => {
    steps.rows = [{ id: 'a' }];
    render(<GovernApprovalsPage />);
    fireEvent.click(screen.getByText('All'));
    expect(screen.getByText('1 step total')).toBeTruthy();
  });
});
