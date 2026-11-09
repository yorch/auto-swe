// @vitest-environment jsdom

import type { MeNeedsYouItem, MeSummary } from '@auto-swe/shared/types/api';
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
const useMeSummary = vi.fn();
vi.mock('@/hooks/useMeSummary', () => ({ useMeSummary: () => useMeSummary() }));
vi.mock('@/components/setup/SetupReadiness', () => ({
  SetupReadiness: () => <div>setup readiness</div>,
}));
vi.mock('@/components/setup/GovernanceGuide', () => ({
  GOVERNANCE_DISMISS_KEY: 'governance-guide',
  GovernanceGuide: () => <div>governance guide</div>,
}));
vi.mock('@/components/setup/FirstRunChecklist', () => ({
  FIRST_RUN_DISMISS_KEY: 'first-run-checklist',
  FirstRunChecklist: () => null,
}));
vi.mock('@/components/setup/RestoreGuides', () => ({ RestoreGuides: () => null }));

import HomePage from './page';

const ready = { error: null, isError: false, isFetching: false, isLoading: false, isSuccess: true };
const bucket = (total: number) => ({ ...ready, data: { data: [], meta: { total } } });

function item(overrides: Partial<MeNeedsYouItem> = {}): MeNeedsYouItem {
  return {
    dueAt: null,
    key: 'k1',
    kind: 'failed_run',
    occurredAt: '2026-01-01T00:00:00Z',
    repoName: 'acme/api',
    requestId: 'req-1',
    runId: 'run-1',
    teamId: 't1',
    teamName: 'Payments',
    teamSlug: 'payments',
    title: 'Fix login',
    ...overrides,
  };
}

function summary(items: MeNeedsYouItem[] = [], total = items.length): MeSummary {
  return {
    needsYou: { items, total },
    teams: [
      {
        myRole: 'LEAD',
        name: 'Payments',
        needsYou: items.length,
        orgId: 'o1',
        orgName: 'Acme',
        queued: 0,
        running: 1,
        slug: 'payments',
        teamId: 't1',
      },
    ],
  };
}

const withSummary = (data: MeSummary) => useMeSummary.mockReturnValue({ ...ready, data });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Home product tour', () => {
  it('offers the tour as a button and never opens it on its own', () => {
    useRequests.mockReturnValue(bucket(0));
    withSummary(summary());
    render(<HomePage />);
    expect(screen.getByRole('button', { name: /^Take the tour/ })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('My desk', () => {
  it('moves the lifecycle explainer into the Help panel instead of the page', () => {
    useRequests.mockReturnValue(bucket(0));
    withSummary(summary());
    render(<HomePage />);
    expect(document.querySelector('details')).toBeNull();
    expect(
      screen
        .getAllByTestId('page-help')
        .some((help) => help.textContent?.includes('How auto-swe works'))
    ).toBe(true);
  });

  it('lists what needs you, in flight and recent results, without the old scope toggle or tiles', () => {
    useRequests.mockReturnValue(bucket(2));
    withSummary(summary([item()]));
    render(<HomePage />);
    expect(screen.getByRole('heading', { name: /^Needs you/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /In flight \(mine\)/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Recent results \(mine\)/ })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Overview' })).toBeNull();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByText('Waiting on you')).toBeNull();
    expect(screen.getByText('Fix login')).toBeTruthy();
  });

  it('asks for MINE requests that ignore the top-bar team filter', () => {
    useRequests.mockReturnValue(bucket(0));
    withSummary(summary());
    render(<HomePage />);
    const calls = useRequests.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [filters, options] of calls) {
      expect(filters).toMatchObject({ scope: 'MINE' });
      expect(options).toEqual({ ignoreTeam: true });
    }
    expect(calls.map(([f]) => (f as { state: string }).state)).toEqual(
      expect.arrayContaining(['active', 'success'])
    );
  });

  it('shows a calm empty state and the quick start when nothing needs you and nothing runs', () => {
    useRequests.mockReturnValue(bucket(0));
    withSummary(summary());
    render(<HomePage />);
    expect(screen.getByText('Nothing needs you')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Run a workflow/ })).toBeTruthy();
  });

  it('hides the quick start while something needs you', () => {
    useRequests.mockReturnValue(bucket(0));
    withSummary(summary([item()]));
    render(<HomePage />);
    expect(screen.queryByRole('link', { name: /Run a workflow/ })).toBeNull();
  });

  it('hides the quick start while work is in flight', () => {
    useRequests.mockReturnValue(bucket(3));
    withSummary(summary());
    render(<HomePage />);
    expect(screen.queryByRole('link', { name: /Run a workflow/ })).toBeNull();
  });

  it('does not offer the quick start until the summary has loaded', () => {
    useRequests.mockReturnValue(bucket(0));
    useMeSummary.mockReturnValue({ ...ready, data: undefined, isLoading: true, isSuccess: false });
    render(<HomePage />);
    expect(screen.queryByRole('link', { name: /Run a workflow/ })).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('says so, with a Retry, when the summary fails, rather than reading as empty', () => {
    useRequests.mockReturnValue(bucket(0));
    const refetch = vi.fn();
    useMeSummary.mockReturnValue({
      ...ready,
      data: undefined,
      error: new Error('boom'),
      isError: true,
      isSuccess: false,
      refetch,
    });
    render(<HomePage />);
    expect(screen.queryByText('Nothing needs you')).toBeNull();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Run a workflow/ })).toBeNull();
  });

  it('keeps the governance guide and a primary Start work action', () => {
    useRequests.mockReturnValue(bucket(0));
    withSummary(summary());
    render(<HomePage />);
    expect(screen.getByText('governance guide')).toBeTruthy();
    expect(screen.getByText('setup readiness')).toBeTruthy();
    const header = within(document.querySelector('header') as HTMLElement);
    expect(header.getByRole('link', { name: 'Start work' }).getAttribute('href')).toBe('/start');
  });
});
