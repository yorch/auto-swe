// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { FirstRunChecklist } from './FirstRunChecklist';

let role = 'ENGINEER';
vi.mock('@/hooks/useHasRole', () => ({
  useHasRole: (required: string) => {
    const rank: Record<string, number> = { ADMIN: 3, ENGINEER: 1, LEAD: 2 };
    return rank[role] >= rank[required];
  },
}));

interface Q {
  isLoading: boolean;
  isError?: boolean;
  data?: unknown;
  meta?: { total: number };
}
const state: { repos: Q; requests: Q; merged: Q } = {
  merged: { isLoading: false, meta: { total: 0 } },
  repos: { data: [], isLoading: false },
  requests: { data: { meta: { total: 0 } }, isLoading: false },
};
const calls = {
  merged: vi.fn(),
  repos: vi.fn(),
  requests: vi.fn(),
};
vi.mock('@/hooks/useRepositories', () => ({
  useRepositories: (...args: unknown[]) => {
    calls.repos(...args);
    return state.repos;
  },
}));
vi.mock('@/hooks/useRequests', () => ({
  useRequests: (...args: unknown[]) => {
    calls.requests(...args);
    return state.requests;
  },
}));
vi.mock('@/hooks/useWorkViews', () => ({
  usePullRequests: (...args: unknown[]) => {
    calls.merged(...args);
    return state.merged;
  },
}));

const GIT = { id: 'r1', type: 'git_repo' };

function reset() {
  state.repos = { data: [], isLoading: false };
  state.requests = { data: { meta: { total: 0 } }, isLoading: false };
  state.merged = { isLoading: false, meta: { total: 0 } };
  for (const fn of Object.values(calls)) {
    fn.mockClear();
  }
}

beforeEach(() => {
  reset();
  role = 'ENGINEER';
  localStorage.clear();
  useAuthStore.setState({ user: { role: 'ENGINEER', sub: 'u1' } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAuthStore.setState({ user: null });
});

const hrefs = () => screen.getAllByRole('link').map((a) => a.getAttribute('href'));

describe('FirstRunChecklist', () => {
  it('shows three tracked steps and one untracked pointer with their links', () => {
    render(<FirstRunChecklist />);
    expect(screen.getByText('0 of 3 done')).toBeTruthy();
    expect(hrefs()).toEqual(['/connections', '/start', '/govern/approvals', '/pull-requests']);
    expect(screen.getByText(/nothing merges it for you/)).toBeTruthy();
    expect(screen.getByText(/This step is not tracked here/)).toBeTruthy();
    expect(screen.getByText(/\(not tracked\)/)).toBeTruthy();
  });

  it('asks for personal progress without the selected-team filter', () => {
    render(<FirstRunChecklist />);
    expect(calls.repos).toHaveBeenCalledWith({ limit: 500 });
    expect(calls.requests).toHaveBeenCalledWith(
      { limit: 1, scope: 'MINE', state: 'all' },
      { ignoreTeam: true }
    );
    expect(calls.merged).toHaveBeenCalledWith(
      { draft: 'any', limit: 1, offset: 0, scope: 'MINE', state: 'MERGED' },
      { ignoreTeam: true }
    );
  });

  it('words the repository step for someone who may not be able to connect one', () => {
    render(<FirstRunChecklist />);
    expect(
      screen.getByText(/If you lead a team, connect one; otherwise ask a lead or an admin/)
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open connections/ })).toBeTruthy();
    cleanup();
    role = 'LEAD';
    render(<FirstRunChecklist />);
    expect(screen.getByRole('link', { name: /Connect a repository/ })).toBeTruthy();
  });

  it('counts only git repositories, not other connection types', () => {
    state.repos = { data: [{ id: 'c1', type: 'issue_tracker' }], isLoading: false };
    render(<FirstRunChecklist />);
    expect(screen.getByText('0 of 3 done')).toBeTruthy();
    cleanup();
    state.repos = { data: [{ id: 'c1', type: 'issue_tracker' }, GIT], isLoading: false };
    render(<FirstRunChecklist />);
    expect(screen.getByText('1 of 3 done')).toBeTruthy();
  });

  it('derives each tick from data, not from clicks', () => {
    state.repos = { data: [GIT], isLoading: false };
    state.requests = { data: { meta: { total: 1 } }, isLoading: false };
    render(<FirstRunChecklist />);
    expect(screen.getByText('2 of 3 done')).toBeTruthy();
    expect(hrefs()).toEqual(['/govern/approvals', '/pull-requests']);
  });

  it('never ticks the gate step, and hides once the three tracked steps are done', () => {
    state.repos = { data: [GIT], isLoading: false };
    state.requests = { data: { meta: { total: 1 } }, isLoading: false };
    render(<FirstRunChecklist />);
    expect(screen.getByRole('link', { name: /Open approvals/ })).toBeTruthy();
    cleanup();
    state.merged = { isLoading: false, meta: { total: 1 } };
    render(<FirstRunChecklist />);
    expect(screen.queryByTestId('first-run-checklist')).toBeNull();
  });

  it('does not treat an unreadable result as done', () => {
    state.requests = { data: undefined, isLoading: false };
    state.merged = { isLoading: false, meta: undefined };
    render(<FirstRunChecklist />);
    expect(screen.getByText('0 of 3 done')).toBeTruthy();
  });

  it.each(['repos', 'requests', 'merged'] as const)(
    'shows nothing, not a false prompt, when the %s query errors',
    (which) => {
      state[which] = { isError: true, isLoading: false };
      render(<FirstRunChecklist />);
      expect(screen.queryByTestId('first-run-checklist')).toBeNull();
      expect(screen.queryByText(/No repository is visible/)).toBeNull();
    }
  );

  it('renders nothing while data is loading', () => {
    state.repos = { isLoading: true };
    render(<FirstRunChecklist />);
    expect(screen.queryByTestId('first-run-checklist')).toBeNull();
  });

  it('renders nothing for an admin', () => {
    role = 'ADMIN';
    render(<FirstRunChecklist />);
    expect(screen.queryByTestId('first-run-checklist')).toBeNull();
  });

  it('dismisses, persists per viewer, and stays hidden on remount', () => {
    const { unmount } = render(<FirstRunChecklist />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the first-run checklist' }));
    expect(screen.queryByTestId('first-run-checklist')).toBeNull();
    expect(localStorage.getItem('auto-swe.dismissed.u1.first-run-checklist')).toBe('1');
    unmount();
    render(<FirstRunChecklist />);
    expect(screen.queryByTestId('first-run-checklist')).toBeNull();
    cleanup();
    useAuthStore.setState({ user: { role: 'ENGINEER', sub: 'u2' } });
    render(<FirstRunChecklist />);
    expect(screen.getByTestId('first-run-checklist')).toBeTruthy();
  });

  it('moves focus to the main region when dismissed', () => {
    render(
      <main id="main-content" tabIndex={-1}>
        <FirstRunChecklist />
      </main>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the first-run checklist' }));
    expect(document.activeElement?.id).toBe('main-content');
  });

  it('works and dismisses for the page view when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<FirstRunChecklist />);
    expect(screen.getByTestId('first-run-checklist')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the first-run checklist' }));
    expect(screen.queryByTestId('first-run-checklist')).toBeNull();
  });
});
