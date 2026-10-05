// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
const useRequests = vi.fn();
const useEpics = vi.fn();
vi.mock('@/hooks/useRequests', () => ({
  useRequests: (...args: unknown[]) => useRequests(...args),
}));
vi.mock('@/hooks/useEpics', () => ({ useEpics: (...args: unknown[]) => useEpics(...args) }));

import RequestsPage from './page';

const settled = { error: null, isError: false, isFetching: false, isLoading: false };
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Requests page epics', () => {
  it('links to the epics list from the header', () => {
    nav.search = '';
    useRequests.mockReturnValue({ ...settled, data: { data: [], meta: { total: 0 } } });
    useEpics.mockReturnValue({ ...settled, data: undefined });
    render(<RequestsPage />);
    const link = screen.getByRole('link', { name: 'Multi-repo epics' });
    expect(link.getAttribute('href')).toBe('/epics');
  });

  it('lists epics when the type filter is epics, and only queries epics', () => {
    nav.search = 'type=epics';
    useRequests.mockReturnValue({ ...settled, data: undefined });
    useEpics.mockReturnValue({
      ...settled,
      data: {
        data: [
          {
            createdAt: '2026-10-01T00:00:00Z',
            description: 'Rename the billing field everywhere',
            epicWorkflowId: 'epic-1',
            externalTicketId: 'EPIC-9',
            repoCount: 3,
            status: 'RUNNING',
            workRequestId: 'wr-1',
          },
        ],
        meta: { total: 1 },
      },
    });
    render(<RequestsPage />);
    expect(screen.getByText('EPIC-9')).toBeTruthy();
    expect(useRequests.mock.calls[0][1]).toEqual({ enabled: false });
    expect(useEpics.mock.calls[0][1]).toEqual({ enabled: true });
  });
});
