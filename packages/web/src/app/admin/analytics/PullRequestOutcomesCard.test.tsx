// @vitest-environment jsdom

import type { PullRequestOutcomesResponse } from '@auto-swe/shared/types/api';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { PullRequestOutcomesCard } from './PullRequestOutcomesCard';

afterEach(() => vi.unstubAllGlobals());

const summary = (over: Partial<PullRequestOutcomesResponse['current']> = {}) => ({
  ciStatusCounts: {},
  closedUnmerged: 1,
  draftCount: 0,
  merged: 3,
  mergeRate: 0.75,
  open: 2,
  opened: 6,
  timeToMergeMs: { count: 3, p50: 3_600_000, p95: 7_200_000 },
  ...over,
});

const response = (
  over: Partial<PullRequestOutcomesResponse> = {}
): PullRequestOutcomesResponse => ({
  byRepository: [{ repository: { id: 'r1', name: 'api', org: 'acme' }, summary: summary() }],
  byTemplate: [
    {
      closedUnmerged: 1,
      medianTimeToMergeMs: 3_600_000,
      merged: 3,
      mergeRate: 0.75,
      opened: 6,
      templateId: 'template-1',
      templateName: 'Build',
    },
  ],
  current: summary(),
  isTruncated: false,
  previous: summary({ merged: 2, mergeRate: 0.5, opened: 4 }),
  previousComplete: true,
  window: { days: 30, end: '2026-09-30T00:00:00.000Z', start: '2026-09-01T00:00:00.000Z' },
  ...over,
});

function renderCard(data: PullRequestOutcomesResponse) {
  const spy = setupFetchMock({ 'GET /api/v1/pull-requests/outcomes': () => ({ data }) });
  render(
    withQuery(<PullRequestOutcomesCard range={{ days: 30, kind: 'preset' }} windowDays={30} />)
  );
  return spy;
}

describe('PullRequestOutcomesCard', () => {
  it('shows the merge rate against the previous window, time to merge and the top repositories', async () => {
    const spy = renderCard(response());
    expect((await screen.findAllByText('75.0%')).length).toBeGreaterThan(0);
    expect(screen.getByText('3 merged, 1 closed unmerged', { exact: false })).toBeTruthy();
    // 0.5 -> 0.75 is +25 percentage points.
    expect(screen.getByText(/\+25\.0 pts vs previous 30 days/)).toBeTruthy();
    expect(screen.getByText('Time to merge, median')).toBeTruthy();
    expect(screen.getAllByText('1h').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2h').length).toBeGreaterThan(0);
    expect(screen.getByText('2 still open')).toBeTruthy();
    expect(screen.getAllByText('acme/api').length).toBeGreaterThan(0);
    expect(screen.getByText('Top templates by PRs opened')).toBeTruthy();
    expect(screen.getByText('Build')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Repository' })).toBeTruthy();
    expect(String(spy.mock.calls[0]?.[0])).toContain('/api/v1/pull-requests/outcomes?window=30');
  });

  it('filters outcomes by repository', async () => {
    const spy = renderCard(response());
    await screen.findByText('Build');
    fireEvent.change(screen.getByRole('combobox', { name: 'Repository' }), {
      target: { value: 'r1' },
    });
    await waitFor(() => {
      expect(spy.mock.calls.some(([input]) => String(input).includes('repoId=r1'))).toBe(true);
    });
  });

  it('sends a custom range as since and until', async () => {
    const spy = setupFetchMock({
      'GET /api/v1/pull-requests/outcomes': () => ({ data: response() }),
    });
    render(
      withQuery(
        <PullRequestOutcomesCard
          range={{ from: '2026-09-01', kind: 'custom', to: '2026-09-14' }}
          windowDays={14}
        />
      )
    );
    await screen.findAllByText('75.0%');
    expect(String(spy.mock.calls[0]?.[0])).toContain('since=2026-09-01&until=2026-09-14');
  });

  it('shows no comparison, and says why, when the previous window is incomplete', async () => {
    renderCard(response({ previous: null, previousComplete: false }));
    expect((await screen.findAllByText('75.0%')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/vs previous/)).toBeNull();
    expect(screen.getByText(/No comparison with the previous window/)).toBeTruthy();
  });

  it('warns when the current window itself was cut by the row cap', async () => {
    renderCard(response({ isTruncated: true, previous: null, previousComplete: false }));
    expect(
      await screen.findByText(/Results capped at the 10,000 most recently opened/)
    ).toBeTruthy();
  });

  it('shows dashes while nothing has been decided or merged', async () => {
    renderCard(
      response({
        current: summary({
          closedUnmerged: 0,
          merged: 0,
          mergeRate: null,
          timeToMergeMs: { count: 0, p50: null, p95: null },
        }),
        previous: null,
        previousComplete: true,
      })
    );
    expect((await screen.findAllByText('Merge rate')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('says so when no pull request was opened', async () => {
    renderCard(response({ byRepository: [], current: summary({ opened: 0 }) }));
    expect(await screen.findByText('No pull requests were opened in this window.')).toBeTruthy();
  });

  it('shows its own error with a retry, without taking the page down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 })
      )
    );
    render(
      withQuery(<PullRequestOutcomesCard range={{ days: 30, kind: 'preset' }} windowDays={30} />)
    );
    expect(await screen.findByText(/Could not load pull request outcomes/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
