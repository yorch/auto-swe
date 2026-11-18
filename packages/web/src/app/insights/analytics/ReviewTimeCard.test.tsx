// @vitest-environment jsdom

import type { PullRequestReviewTimeResponse } from '@auto-swe/shared/types/api';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { ReviewTimeCard } from './ReviewTimeCard';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const stats = (p50: number | null, count = 4) => ({
  count,
  p50,
  p90: p50 === null ? null : p50 * 3,
});

const summary = (
  over: Partial<PullRequestReviewTimeResponse['overall']> = {}
): PullRequestReviewTimeResponse['overall'] => ({
  changeRequestRate: 0.25,
  lowSample: false,
  pullRequests: 12,
  reviewed: 8,
  reviewRounds: { max: 3, mean: 1.5, median: 1 },
  reviewToMerge: stats(7_200_000),
  timeToFirstReview: stats(3_600_000),
  timeToFirstView: stats(1_800_000),
  unmeasured: 2,
  ...over,
});

const response = (
  over: Partial<PullRequestReviewTimeResponse> = {}
): PullRequestReviewTimeResponse => ({
  byRepository: [
    { repository: { id: 'r1', name: 'api', org: 'acme' }, summary: summary({ pullRequests: 9 }) },
  ],
  byTeam: [{ summary: summary(), teamId: 't1', teamName: 'Payments' }],
  overall: summary(),
  queue: {
    batches: { deep: 0, none: 0, quick: 1, standard: 2 },
    evaluationsTruncated: false,
    medianWaitingMs: 7_200_000,
    needsHuman: 3,
    oldestWaitingMs: 86_400_000,
    open: 5,
    truncated: false,
  },
  truncated: false,
  window: { days: 30, end: '2026-09-30T00:00:00.000Z', start: '2026-09-01T00:00:00.000Z' },
  ...over,
});

function renderCard(data: PullRequestReviewTimeResponse) {
  const spy = setupFetchMock({ 'GET /api/v1/pull-requests/review-time': () => ({ data }) });
  render(withQuery(<ReviewTimeCard range={{ days: 30, kind: 'preset' }} />));
  return spy;
}

describe('ReviewTimeCard', () => {
  it('shows the wait for a first review, the queue and the per-repository and team rows', async () => {
    const spy = renderCard(response());
    expect(await screen.findByText('Time to first review, median')).toBeTruthy();
    expect(screen.getByText('25.0%')).toBeTruthy();
    expect(screen.getByText('8 reviewed of 12, 2 not measurable')).toBeTruthy();
    expect(screen.getByText('Waiting on a person')).toBeTruthy();
    expect(screen.getByText('5 open in all')).toBeTruthy();
    expect(screen.getByText('acme/api')).toBeTruthy();
    expect(screen.getByText('Payments')).toBeTruthy();
    expect(String(spy.mock.calls[0]?.[0])).toContain('/api/v1/pull-requests/review-time?window=30');
  });

  it('warns about a low sample and a cut read', async () => {
    renderCard(response({ overall: summary({ lowSample: true, reviewed: 1 }), truncated: true }));
    expect(await screen.findByText(/too few for these figures/)).toBeTruthy();
    expect(screen.getByText(/A row cap cut into this window/)).toBeTruthy();
  });

  it('says so when nothing was ready for review', async () => {
    renderCard(
      response({
        byRepository: [],
        byTeam: [],
        overall: summary({ pullRequests: 0 }),
        queue: { ...response().queue, open: 0 },
      })
    );
    expect(await screen.findByText(/No pull requests ready for review/)).toBeTruthy();
  });
});
