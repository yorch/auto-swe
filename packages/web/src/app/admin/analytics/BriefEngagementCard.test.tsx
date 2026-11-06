// @vitest-environment jsdom

import type { PrEngagementResponse } from '@auto-swe/shared/types/api';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { BriefEngagementCard } from './BriefEngagementCard';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const response = (over: Partial<PrEngagementResponse> = {}): PrEngagementResponse => ({
  capped: false,
  changeRequestRate: 0.25,
  comments: { elsewhere: 2, flagged: 6, flaggedShare: 0.6, skimmed: 2, skimmedShare: 0.2 },
  evaluations: 8,
  medianMinutesToFirstReview: 90,
  medianMinutesToFirstView: 12,
  pullRequestsViewed: 5,
  reviewed: 4,
  windowDays: 30,
  ...over,
});

function renderCard(data: PrEngagementResponse, windowDays = 30) {
  const spy = setupFetchMock({ '/api/v1/pr-evaluations/engagement': () => ({ data }) });
  render(withQuery(<BriefEngagementCard windowDays={windowDays} />));
  return spy;
}

describe('BriefEngagementCard', () => {
  it('shows how many were reviewed, how fast, how often changes were asked for, and where comments land', async () => {
    renderCard(response());
    expect(await screen.findByText('Reviewed')).toBeTruthy();
    // 4 of 8
    expect(screen.getByText('50.0%')).toBeTruthy();
    expect(screen.getByText('4 of 8 evaluations reviewed by a person')).toBeTruthy();
    // 90 minutes is an hour and a half, shown in hours
    expect(screen.getByText('Time to first review, median')).toBeTruthy();
    expect(screen.getByText('1.5h')).toBeTruthy();
    expect(screen.getByText('25.0%')).toBeTruthy();
    expect(screen.getByText('60.0%')).toBeTruthy();
    expect(
      screen.getByText('6 on flagged files, 2 on files marked safe to skim, 2 elsewhere')
    ).toBeTruthy();
  });

  it('shows how soon a pull request is first opened on the review page', async () => {
    renderCard(response());
    expect(await screen.findByText('Time to first view, median')).toBeTruthy();
    expect(screen.getByText('12m')).toBeTruthy();
    expect(screen.getByText(/across 5 pull requests/)).toBeTruthy();
  });

  it('shows a dash for it when nobody has opened the page', async () => {
    renderCard(response({ medianMinutesToFirstView: null, pullRequestsViewed: 0 }));
    expect(await screen.findByText('Time to first view, median')).toBeTruthy();
    expect(screen.getByText(/across 0 pull requests/)).toBeTruthy();
  });

  it('asks for the window it was given', async () => {
    const spy = renderCard(response(), 14);
    await screen.findByText('Reviewed');
    expect(String(spy.mock.calls[0]?.[0])).toContain('/api/v1/pr-evaluations/engagement?days=14');
  });

  it('asks for the longest window the route answers when the range is longer, and says so', async () => {
    const spy = renderCard(response({ windowDays: 365 }), 800);
    expect(await screen.findByText(/the longest window this reads/)).toBeTruthy();
    expect(screen.getByText(/Showing the last 365 days/)).toBeTruthy();
    expect(String(spy.mock.calls[0]?.[0])).toContain('days=365');
  });

  it('says so when the window held more than one read takes', async () => {
    renderCard(response({ capped: true }));
    expect(await screen.findByText(/cover the newest ones only/)).toBeTruthy();
  });

  it('shows a dash where there is nothing to compute', async () => {
    renderCard(
      response({
        changeRequestRate: null,
        comments: { elsewhere: 0, flagged: 0, flaggedShare: null, skimmed: 0, skimmedShare: null },
        medianMinutesToFirstReview: null,
        reviewed: 0,
      })
    );
    expect(await screen.findByText('Reviewed')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('0.0%')).toBeTruthy();
  });

  it('says plainly when no pull request was evaluated', async () => {
    renderCard(
      response({
        changeRequestRate: null,
        comments: { elsewhere: 0, flagged: 0, flaggedShare: null, skimmed: 0, skimmedShare: null },
        evaluations: 0,
        medianMinutesToFirstReview: null,
        reviewed: 0,
      })
    );
    expect(
      await screen.findByText(/No pull requests were evaluated in the last 30 days/)
    ).toBeTruthy();
    expect(screen.queryByText('Reviewed')).toBeNull();
  });

  it('shows the error with a retry when the read fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'X', message: 'boom' } }), {
            headers: { 'content-type': 'application/json' },
            status: 500,
          })
      )
    );
    render(withQuery(<BriefEngagementCard windowDays={30} />));
    expect(await screen.findByText(/Could not load reviewer engagement/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
