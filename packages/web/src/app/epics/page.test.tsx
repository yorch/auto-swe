// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ search: '' }));
vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));
vi.mock('next/navigation', () => ({
  usePathname: () => '/epics',
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
const useEpics = vi.fn();
vi.mock('@/hooks/useEpics', () => ({
  useEpics: (...args: unknown[]) => useEpics(...args),
}));
vi.mock('@/hooks/useHasRole', () => ({ useHasRole: () => true }));

import EpicsPage from './page';

const settled = {
  error: null,
  isError: false,
  isFetching: false,
  isLoading: false,
  refetch: vi.fn(),
};

afterEach(() => {
  cleanup();
  useEpics.mockReset();
  nav.search = '';
});

describe('Epics page', () => {
  it('defines an epic in the subtitle and promises a pull request, not a draft', () => {
    useEpics.mockReturnValue({ ...settled, data: { data: [], meta: { total: 0 } } });
    render(<EpicsPage />);
    expect(screen.getByText(/is a change that spans several repositories/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /What is an epic/ })).toBeTruthy();
    expect(screen.getByText(/each ending in its own pull request for you to review/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/draft/i);
  });

  it('asks for one page at a time, scoped from the address', () => {
    nav.search = 'scope=TEAM&offset=30';
    useEpics.mockReturnValue({ ...settled, data: { data: [], meta: { total: 0 } } });
    render(<EpicsPage />);
    expect(useEpics).toHaveBeenCalledWith({ limit: 30, offset: 30, scope: 'TEAM' });
  });

  it('shows a Mine / My team scope control', () => {
    useEpics.mockReturnValue({ ...settled, data: { data: [], meta: { total: 0 } } });
    render(<EpicsPage />);
    expect(screen.getByRole('button', { name: 'Mine' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'My team' })).toBeTruthy();
  });
});
