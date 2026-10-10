// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useEpics', () => ({
  useEpics: () => ({
    data: { data: [], meta: { total: 0 } },
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/hooks/useHasRole', () => ({ useHasRole: () => true }));

import EpicsPage from './page';

afterEach(cleanup);

describe('Epics page', () => {
  it('defines an epic in the subtitle and promises a pull request, not a draft', () => {
    render(<EpicsPage />);
    expect(screen.getByText(/is a change that spans several repositories/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /What is an epic/ })).toBeTruthy();
    expect(screen.getByText(/each ending in its own pull request for you to review/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/draft/i);
  });
});
