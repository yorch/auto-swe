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

const steps = vi.hoisted(() => ({
  count: null as number | null,
  rows: [] as unknown[],
  teamCount: null as number | null,
}));
const nav = vi.hoisted(() => ({ replace: vi.fn(), search: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/approvals',
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));
const useApprovalsSpy = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useApprovals', () => ({
  useApprovals: (...args: unknown[]) => {
    useApprovalsSpy(...args);
    return {
      data: steps.rows,
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    };
  },
  useApprovalsCount: () => steps.count ?? steps.rows.length,
  useTeamApprovalsCount: (teamId: string | undefined) => (teamId ? steps.teamCount : null),
}));
vi.mock('@/components/approvals/HumanStepCard', () => ({
  HumanStepCard: ({
    defaultExpanded,
    onAnswered,
    step,
  }: {
    defaultExpanded?: boolean;
    onAnswered?: (message: string) => void;
    step: { title?: string };
  }) => (
    <button
      data-expanded={String(Boolean(defaultExpanded))}
      onClick={() => onAnswered?.('Approved “x”.')}
      type="button"
    >
      {step.title}
    </button>
  ),
}));

import GovernApprovalsPage from './page';

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
  nav.search = '';
  nav.replace.mockClear();
  steps.count = null;
});

describe('approvals page cap label', () => {
  it('says so when the All tab hit the server cap', () => {
    steps.rows = Array.from({ length: 200 }, (_, i) => ({ id: String(i) }));
    nav.search = 'tab=ALL';
    render(<GovernApprovalsPage />);
    expect(screen.getByText(/Showing 200 steps, the most this list loads/)).toBeTruthy();
  });

  it('shows a plain total below the cap', () => {
    steps.rows = [{ id: 'a' }];
    nav.search = 'tab=ALL';
    render(<GovernApprovalsPage />);
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
    // The explainer lives in the Help panel, not in a disclosure on the page.
    expect(screen.getByText('What these steps are').closest('details')).toBeNull();
  });
});

const step = (id: string, kind: string, title: string, ticket = 'T-1') => ({
  description: null,
  id,
  kind,
  run: { workRequest: { description: '', externalTicketId: ticket } },
  title,
});

describe('approvals page filters and state', () => {
  it('says the Pending list is capped too, and counts on the tab', () => {
    steps.rows = Array.from({ length: 100 }, (_, i) => step(String(i), 'APPROVAL', `S${i}`));
    render(<GovernApprovalsPage />);
    expect(screen.getByText(/Showing 100 pending steps, the most this list loads/)).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Pending (100)' })).toBeTruthy();
  });

  it('shows the exact gateway total on the tab, past the list cap, with no plus', () => {
    steps.rows = Array.from({ length: 100 }, (_, i) => step(String(i), 'APPROVAL', `S${i}`));
    steps.count = 150;
    render(<GovernApprovalsPage />);
    expect(screen.getByRole('tab', { name: 'Pending (150)' })).toBeTruthy();
  });

  it('keeps the tab, kind and overdue choices in the address', () => {
    steps.rows = [step('a', 'APPROVAL', 'One')];
    render(<GovernApprovalsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Decision' }));
    expect(nav.replace).toHaveBeenLastCalledWith('/approvals?kind=DECISION', { scroll: false });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Overdue only' }));
    expect(nav.replace).toHaveBeenLastCalledWith('/approvals?overdue=1', { scroll: false });
  });

  it('narrows the loaded steps by kind and by title or ticket', () => {
    steps.rows = [
      step('a', 'APPROVAL', 'Approve the plan', 'PAY-1'),
      step('b', 'DECISION', 'Pick a route', 'OPS-2'),
    ];
    nav.search = 'kind=DECISION';
    const first = render(<GovernApprovalsPage />);
    expect(screen.queryByText('Approve the plan')).toBeNull();
    expect(screen.getByText('Pick a route')).toBeTruthy();
    first.unmount();
    nav.search = 'q=pay-1';
    render(<GovernApprovalsPage />);
    expect(screen.getByText('Approve the plan')).toBeTruthy();
    expect(screen.queryByText('Pick a route')).toBeNull();
  });

  it('offers to clear filters when none match', () => {
    steps.rows = [step('a', 'APPROVAL', 'One')];
    nav.search = 'q=zzz';
    render(<GovernApprovalsPage />);
    expect(screen.getByText('No steps match')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' }).at(-1) as HTMLElement);
    expect(nav.replace).toHaveBeenCalled();
  });

  it('opens the only waiting step', () => {
    steps.rows = [step('a', 'APPROVAL', 'Only one')];
    render(<GovernApprovalsPage />);
    expect(screen.getByRole('button', { name: 'Only one' }).dataset.expanded).toBe('true');
  });

  it('announces an answer in a live region and keeps the reader in the list', () => {
    steps.rows = [step('a', 'APPROVAL', 'One'), step('b', 'APPROVAL', 'Two')];
    render(<GovernApprovalsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'One' }));
    expect(screen.getByRole('status').textContent).toContain('Approved “x”.');
  });
});

describe('approvals page team filter', () => {
  it('narrows the steps to the ?team= team and shows a removable chip', () => {
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
    steps.rows = [];
    render(<GovernApprovalsPage />);
    expect(useApprovalsSpy).toHaveBeenCalledWith(
      'PENDING',
      'requestedAt:desc',
      false,
      undefined,
      false,
      expect.objectContaining({ teamId: 'team-1' })
    );
    expect(screen.getByTestId('team-chip').textContent).toContain('Payments');
    fireEvent.click(screen.getByRole('button', { name: 'Remove the Payments team filter' }));
    expect(teamParam.value.clear).toHaveBeenCalledTimes(1);
  });

  it('counts the Pending tab within the team, while the badge hook stays all-teams', () => {
    teamParam.value = {
      ...teamParam.value,
      slug: 'payments',
      team: { name: 'Payments' },
      teamId: 'team-1',
    };
    nav.search = 'team=payments';
    steps.rows = [step('a', 'APPROVAL', 'One')];
    steps.count = 40;
    steps.teamCount = 3;
    render(<GovernApprovalsPage />);
    expect(screen.getByRole('tab', { name: /Pending \(3\)/ })).toBeTruthy();
    steps.teamCount = null;
  });

  it('lists only the steps the caller can answer for ?actionable=1, and says so', () => {
    nav.search = 'team=payments&actionable=1';
    steps.rows = [];
    render(<GovernApprovalsPage />);
    expect(useApprovalsSpy).toHaveBeenCalledWith(
      'PENDING',
      'requestedAt:desc',
      false,
      undefined,
      true,
      expect.anything()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show all pending' }));
    expect(nav.replace.mock.calls.at(-1)?.[0]).not.toContain('actionable');
  });
});
