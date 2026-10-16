// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
const useRequests = vi.fn();
vi.mock('@/hooks/useRequests', () => ({
  useRequests: (...args: unknown[]) => useRequests(...args),
}));
const approvals = vi.fn(() => ({ data: [] as { id: string }[], isLoading: false }));
vi.mock('@/hooks/useApprovals', () => ({
  useApprovals: () => approvals(),
}));
vi.mock('@/components/approvals/HumanStepCard', () => ({
  HumanStepCard: () => <div>step card</div>,
}));
vi.mock('@/components/setup/SetupReadiness', () => ({ SetupReadiness: () => null }));
vi.mock('@/components/setup/GovernanceGuide', () => ({ GovernanceGuide: () => null }));
vi.mock('@/components/setup/FirstRunChecklist', () => ({ FirstRunChecklist: () => null }));

import HomePage from './page';

const ready = { error: null, isError: false, isFetching: false, isLoading: false, isSuccess: true };
const bucket = (total: number) => ({ ...ready, data: { data: [], meta: { total } } });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Home product tour', () => {
  it('offers the tour as a button and never opens it on its own', () => {
    useRequests.mockReturnValue(bucket(0));
    render(<HomePage />);
    expect(screen.getByRole('button', { name: /^Take the tour/ })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Home layout', () => {
  it('moves the lifecycle explainer into the Help panel instead of the page', () => {
    useRequests.mockReturnValue(bucket(0));
    render(<HomePage />);
    expect(document.querySelector('details')).toBeNull();
    expect(
      screen
        .getAllByTestId('page-help')
        .some((help) => help.textContent?.includes('How auto-swe works'))
    ).toBe(true);
  });

  it('shows each approval surface once: no tile, no top-bar pill, one section when waiting', () => {
    useRequests.mockReturnValue(bucket(2));
    render(<HomePage />);
    // Three overview tiles for the request buckets; no "Waiting on you" tile.
    expect(screen.queryByRole('link', { name: /Waiting on you/ })).toBeNull();
    expect(screen.queryByText('Waiting on you')).toBeNull();
    const overview = within(screen.getByRole('region', { name: 'Overview' }));
    expect(overview.getByText('Needs your attention')).toBeTruthy();
    expect(overview.getByText('In progress')).toBeTruthy();
    expect(overview.getByText('Recent results')).toBeTruthy();
  });

  it('makes the overview figures plain text, not links that scroll the page', () => {
    useRequests.mockReturnValue(bucket(2));
    render(<HomePage />);
    const overview = within(screen.getByRole('region', { name: 'Overview' }));
    expect(overview.queryAllByRole('link')).toHaveLength(0);
  });

  it('offers one Start work entry, the quick-start card, and no duplicate shortcuts', () => {
    useRequests.mockReturnValue(bucket(0));
    render(<HomePage />);
    expect(screen.queryByRole('link', { name: 'Start work' })).toBeNull();
    expect(screen.getByRole('link', { name: /Run a workflow/ })).toBeTruthy();
    expect(screen.queryByText('Jump to')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Tickets' })).toBeNull();
  });
});

describe('Home waiting on you', () => {
  it('lists pending approvals in a single section', () => {
    useRequests.mockReturnValue(bucket(0));
    approvals.mockReturnValue({ data: [{ id: 's1' }], isLoading: false });
    render(<HomePage />);
    expect(screen.getAllByRole('heading', { name: 'Waiting on you' })).toHaveLength(1);
  });
});
