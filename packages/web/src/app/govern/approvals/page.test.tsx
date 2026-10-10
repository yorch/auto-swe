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

  it('describes each gate type and the timeout behaviour', () => {
    steps.rows = [];
    render(<GovernApprovalsPage />);
    for (const type of ['humanApproval', 'humanDecision', 'humanInput', 'humanReview']) {
      expect(screen.getByText(type)).toBeTruthy();
    }
    expect(screen.getByText(/If nobody answers in time/)).toBeTruthy();
    expect(screen.getByText(/marked timed out and the run follows/)).toBeTruthy();
    // No interactive control may sit inside the <summary>.
    expect(
      screen.getByText('What these steps are').closest('summary')?.querySelector('button')
    ).toBeNull();
  });
});
