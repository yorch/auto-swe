// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
const useRequests = vi.fn();
vi.mock('@/hooks/useRequests', () => ({
  useRequests: (...args: unknown[]) => useRequests(...args),
}));
vi.mock('@/hooks/useApprovals', () => ({
  useApprovals: () => ({ data: [], isLoading: false }),
}));
vi.mock('@/components/setup/SetupReadiness', () => ({ SetupReadiness: () => null }));

import HomePage from './page';

const ready = { error: null, isError: false, isFetching: false, isLoading: false, isSuccess: true };
const bucket = (total: number) => ({ ...ready, data: { data: [], meta: { total } } });
const details = () => document.querySelector('details') as HTMLDetailsElement;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Home "How auto-swe works"', () => {
  it('is open for a user with no requests in any bucket', () => {
    useRequests.mockReturnValue(bucket(0));
    render(<HomePage />);
    expect(details().hasAttribute('open')).toBe(true);
  });

  it('is closed once the user has requests', () => {
    useRequests.mockReturnValue(bucket(3));
    render(<HomePage />);
    expect(details().hasAttribute('open')).toBe(false);
  });

  it('stays closed while the buckets are still loading', () => {
    useRequests.mockReturnValue({ ...ready, data: undefined, isLoading: true, isSuccess: false });
    render(<HomePage />);
    expect(details().hasAttribute('open')).toBe(false);
  });

  it('stays closed when one bucket query errors, even if the others are empty', () => {
    useRequests.mockImplementation((params: { state: string }) =>
      params.state === 'success'
        ? {
            ...ready,
            data: undefined,
            error: new Error('boom'),
            isError: true,
            isSuccess: false,
          }
        : bucket(0)
    );
    render(<HomePage />);
    expect(details().hasAttribute('open')).toBe(false);
  });

  it('keeps a manual toggle when switching between My work and Team work', () => {
    useRequests.mockReturnValue(bucket(0));
    render(<HomePage />);
    expect(details().open).toBe(true);
    details().open = false; // the user collapses it
    fireEvent.click(screen.getByRole('button', { name: 'Team work' }));
    expect(details().open).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'My work' }));
    expect(details().open).toBe(false);
  });
});
