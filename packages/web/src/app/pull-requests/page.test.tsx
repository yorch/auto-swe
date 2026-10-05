// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ replace: vi.fn(), search: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/pull-requests',
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
const usePullRequests = vi.fn();
vi.mock('@/hooks/useWorkViews', () => ({
  usePullRequests: (...args: unknown[]) => usePullRequests(...args),
}));
vi.mock('@/hooks/useRepositories', () => ({ useRepositories: () => ({ data: [] }) }));

import PullRequestsPage from './page';

const settled = { error: null, isError: false, isFetching: false, isLoading: false };
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Pull requests page', () => {
  it('asks for open pull requests, any draft state, and the caller’s own, by default', () => {
    nav.search = '';
    usePullRequests.mockReturnValue({ ...settled, data: [], meta: { total: 0 } });
    render(<PullRequestsPage />);
    expect(usePullRequests).toHaveBeenCalledWith(
      expect.objectContaining({ draft: 'any', offset: 0, scope: 'MINE', state: 'OPEN' })
    );
    expect(screen.getByText('No open pull requests')).toBeTruthy();
  });

  it('reads its filters from the address and ignores values it does not know', () => {
    nav.search = 'state=MERGED&draft=ready&scope=TEAM&ticket=JIRA-1&offset=30&repo=r1';
    usePullRequests.mockReturnValue({ ...settled, data: [], meta: { total: 0 } });
    render(<PullRequestsPage />);
    expect(usePullRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: 'ready',
        offset: 30,
        repoId: 'r1',
        scope: 'TEAM',
        state: 'MERGED',
        ticket: 'JIRA-1',
      })
    );
    expect(screen.getByText('No pull requests match these filters')).toBeTruthy();

    nav.search = 'state=bogus&draft=bogus';
    render(<PullRequestsPage />);
    expect(usePullRequests).toHaveBeenLastCalledWith(
      expect.objectContaining({ draft: 'any', state: 'OPEN' })
    );
  });

  it('keeps "all states" distinct from the open default', () => {
    nav.search = 'state=all';
    usePullRequests.mockReturnValue({ ...settled, data: [], meta: { total: 0 } });
    render(<PullRequestsPage />);
    expect(usePullRequests).toHaveBeenCalledWith(expect.objectContaining({ state: 'all' }));
  });
});
