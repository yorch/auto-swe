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
    nav.search =
      'state=MERGED&draft=ready&scope=TEAM&ticket=JIRA-1&offset=30&repo=3f2b8c1e-7a4d-4e5b-9c10-1a2b3c4d5e6f';
    usePullRequests.mockReturnValue({ ...settled, data: [], meta: { total: 0 } });
    render(<PullRequestsPage />);
    expect(usePullRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: 'ready',
        offset: 30,
        repoId: '3f2b8c1e-7a4d-4e5b-9c10-1a2b3c4d5e6f',
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

  it('does not send a repository that is not a uuid', () => {
    nav.search = 'repo=not-a-uuid';
    usePullRequests.mockReturnValue({ ...settled, data: [], meta: { total: 0 } });
    render(<PullRequestsPage />);
    expect(usePullRequests).toHaveBeenCalledWith(expect.objectContaining({ repoId: undefined }));
  });

  it('keeps "all states" distinct from the open default', () => {
    nav.search = 'state=all';
    usePullRequests.mockReturnValue({ ...settled, data: [], meta: { total: 0 } });
    render(<PullRequestsPage />);
    expect(usePullRequests).toHaveBeenCalledWith(expect.objectContaining({ state: 'all' }));
  });
});
