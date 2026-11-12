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

const nav = vi.hoisted(() => ({ replace: vi.fn(), search: '' }));
const search = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  usePathname: () => '/runs',
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));
vi.mock('@/hooks/useTemplates', () => ({ useWorkflowTemplates: () => ({ data: [] }) }));
vi.mock('@/components/runs/useRunsSearch', () => ({
  useRunsSearch: (...args: unknown[]) => search(...args),
}));
vi.mock('@/components/runs/RunsTable', () => ({
  RunsTable: ({ runs }: { runs: { id: string }[] }) => <div>{runs.length} rows</div>,
}));

import WorkflowRunsPage from './page';

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
  nav.search = '';
  nav.replace.mockClear();
  search.mockReset();
});

describe('runs page filters', () => {
  it.each(['', 'scope=ALL', 'scope=TEAM'])(
    'keeps legacy team-wide scope semantics for %s',
    (query) => {
      nav.search = query;
      search.mockReturnValue({ ...settled, data: { data: [], meta: { total: 0 } } });
      render(<WorkflowRunsPage />);
      expect(search.mock.calls[0][0].scope).toBeUndefined();
      expect(screen.getByRole('button', { name: 'My team' }).getAttribute('aria-pressed')).toBe(
        'true'
      );
    }
  );
  it('switches back to team-wide work without losing the other URL filters', () => {
    nav.search = 'scope=MINE&team=payments&status=FAILED&offset=50';
    search.mockReturnValue({ ...settled, data: { data: [], meta: { total: 0 } } });
    render(<WorkflowRunsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'My team' }));
    expect(nav.replace).toHaveBeenLastCalledWith('/runs?team=payments&status=FAILED', {
      scroll: false,
    });
  });
  it('searches by the address and asks for my runs only when scoped', () => {
    nav.search = 'q=login&scope=MINE';
    search.mockReturnValue({
      ...settled,
      data: { data: [{ id: 'r1' }], meta: { limit: 50, offset: 0, total: 1 } },
    });
    render(<WorkflowRunsPage />);
    expect(search.mock.calls[0][0]).toMatchObject({ q: 'login', scope: 'MINE' });
    expect((screen.getByRole('searchbox', { name: 'Search runs' }) as HTMLInputElement).value).toBe(
      'login'
    );
    expect(screen.getByRole('button', { name: 'Mine' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('puts the scope in the address and offers to clear every filter', () => {
    nav.search = 'q=login';
    search.mockReturnValue({
      ...settled,
      data: { data: [], meta: { limit: 50, offset: 0, total: 0 } },
    });
    render(<WorkflowRunsPage />);
    expect(screen.getByText('No runs match these filters')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mine' }));
    expect(nav.replace).toHaveBeenLastCalledWith('/runs?q=login&scope=MINE', { scroll: false });
  });

  it('shows the range of a paged list in the toolbar', () => {
    search.mockReturnValue({
      ...settled,
      data: {
        data: Array.from({ length: 50 }, (_, i) => ({ id: String(i) })),
        meta: { limit: 50, offset: 0, total: 120 },
      },
    });
    render(<WorkflowRunsPage />);
    expect(screen.getByText('1–50 of 120 runs')).toBeTruthy();
  });
});

describe('runs page team filter', () => {
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
    search.mockReturnValue({
      ...settled,
      data: { data: [], meta: { limit: 50, offset: 0, total: 0 } },
    });
    render(<WorkflowRunsPage />);
    expect(search.mock.calls[0][0]).toMatchObject({ teamId: 'team-1' });
    expect(screen.getByTestId('team-chip').textContent).toContain('Payments');
    fireEvent.click(screen.getByRole('button', { name: 'Remove the Payments team filter' }));
    expect(teamParam.value.clear).toHaveBeenCalledTimes(1);
  });
});
