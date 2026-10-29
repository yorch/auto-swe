// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetNavigation } from '@/test/mockNavigation';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());
// Recharts needs a laid-out container; record what the chart was handed instead.
const chartData = vi.fn();
vi.mock('@/components/charts/WorkflowsOverTimeChart', () => ({
  WorkflowsOverTimeChart: ({ data }: { data: unknown }) => {
    chartData(data);
    return <div data-testid="runs-chart" />;
  },
}));

import GlobalAnalyticsPage from './page';

beforeEach(() => resetNavigation('', '/admin/analytics'));
afterEach(() => {
  vi.unstubAllGlobals();
  chartData.mockReset();
});

const analytics = {
  approvalLatency: {
    cancelled: 1,
    isTruncated: false,
    pending: 2,
    perTemplate: [
      {
        cancelled: 1,
        pending: 2,
        resolved: { count: 4, p50Ms: 120_000, p95Ms: 600_000 },
        templateId: 't1',
        templateName: 'Ticket to PR',
        timedOut: 1,
      },
    ],
    resolved: { count: 4, p50Ms: 120_000, p95Ms: 600_000 },
    timedOut: 1,
  },
  autonomyRate: 0.5,
  completedRuns: 9,
  daily: [{ active: 0, completed: 7, date: '2026-09-01', failed: 2 }],
  estimatedHumanTimeSavedTotal: 120,
  failed: 2,
  humanReviewRate: 0.25,
  isTruncated: false,
  perDomain: [
    {
      agentErrorRate: 0.2,
      baselineSampleSize: 10,
      domain: 'code',
      errorRateVsHuman: null,
      estimatedHumanTimeSavedTotal: 120,
      humanErrorRate: null,
      totalCost: 4,
      totalRuns: 10,
    },
    {
      agentErrorRate: null,
      baselineSampleSize: null,
      domain: 'git_repo',
      errorRateVsHuman: null,
      estimatedHumanTimeSavedTotal: null,
      humanErrorRate: null,
      totalCost: 0.5,
      totalRuns: 1,
    },
  ],
  perOutcome: [
    { outcomeType: 'git_repo', runCount: 2, totalCost: 1 },
    { outcomeType: 'unknown', runCount: 3, totalCost: 1 },
    { outcomeType: 'PR_OPENED', runCount: 7, totalCost: 3 },
  ],
  perTemplate: [
    {
      estimatedHumanTimeSavedTotal: null,
      successRate: 0.7,
      templateId: 't1',
      templateName: 'Ticket to PR',
      totalCost: 4,
      totalRuns: 10,
    },
  ],
  previous: {
    autonomyRate: 0.5,
    estimatedHumanTimeSavedTotal: 60,
    humanReviewRate: 0.2,
    successRate: 0.9,
    totalCost: 8,
    totalRuns: 8,
  },
  runningRuns: 1,
  succeeded: 7,
  successRate: 7 / 9,
  totalCost: 4,
  totalRuns: 10,
  windowDays: 30,
};

const summary = (over: Record<string, unknown> = {}) => ({
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

const outcomes = {
  byRepository: [{ repository: { id: 'r1', name: 'api', org: 'acme' }, summary: summary() }],
  byTemplate: [],
  current: summary(),
  isTruncated: false,
  previous: summary({ merged: 2, mergeRate: 0.5, opened: 4 }),
  previousComplete: true,
  window: { days: 30, end: '2026-09-30T00:00:00.000Z', start: '2026-09-01T00:00:00.000Z' },
};

function mock() {
  return setupFetchMock({
    'GET /api/v1/pull-requests/outcomes': () => ({ data: outcomes }),
    'GET /api/v1/workflow-templates/analytics': () => ({ data: analytics }),
  });
}

describe('GlobalAnalyticsPage', () => {
  it('leads with four headline figures, each against the previous window', async () => {
    mock();
    render(withQuery(<GlobalAnalyticsPage />));

    expect(await screen.findByText('Run cost')).toBeTruthy();
    expect(screen.getByText('Run cost')).toBeTruthy();
    expect(screen.getByText('Est. time saved (successful runs)')).toBeTruthy();
    // Cost fell by half, which is good news, and the rate fell 12 points.
    expect(screen.getByText(/−50% vs previous 30 days/)).toBeTruthy();
    expect(screen.getByText(/−12\.2 pts vs previous 30 days/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See all spend' }).getAttribute('href')).toBe(
      '/admin/usage'
    );
  });

  it('adds pull request outcomes and approval latency below the efficiency figures', async () => {
    mock();
    render(withQuery(<GlobalAnalyticsPage />));

    expect(await screen.findByText('Pull request outcomes')).toBeTruthy();
    expect(await screen.findByText('Time to merge, median')).toBeTruthy();
    expect(screen.getByText('Approval latency')).toBeTruthy();
    expect(screen.getByText('Wait, median')).toBeTruthy();
  });

  it('defines the jargon and charts runs over time', async () => {
    mock();
    render(withQuery(<GlobalAnalyticsPage />));

    expect(await screen.findByText(/needed no human step/)).toBeTruthy();
    expect(screen.getByText(/reviewed or approved/)).toBeTruthy();
    expect(chartData).toHaveBeenCalledWith(analytics.daily);
  });

  it('names outcomes in words and explains a missing human comparison', async () => {
    mock();
    render(withQuery(<GlobalAnalyticsPage />));

    expect(await screen.findByText('Not classified')).toBeTruthy();
    expect(screen.getByText('Pr opened')).toBeTruthy();
    expect(screen.getByText('Too few baseline cases (10)')).toBeTruthy();
  });

  it('labels the workspace and integration breakdowns', async () => {
    mock();
    render(withQuery(<GlobalAnalyticsPage />));

    expect(await screen.findByText('By workspace type')).toBeTruthy();
    expect(screen.getAllByText('Git repository').length).toBeGreaterThan(0);
    expect(screen.getByText('By integration')).toBeTruthy();
  });

  it('asks for the chosen window and keeps it in the URL', async () => {
    const spy = mock();
    render(withQuery(<GlobalAnalyticsPage />));
    await screen.findByText('Run cost');

    fireEvent.click(screen.getByRole('button', { name: '90d' }));

    await waitFor(() =>
      expect(spy.mock.calls.some(([u]) => String(u).includes('window=90'))).toBe(true)
    );
  });

  it('asks the gateway for a custom range from the link', async () => {
    resetNavigation('range=custom&from=2026-09-01&to=2026-09-14', '/admin/analytics');
    const spy = mock();
    render(withQuery(<GlobalAnalyticsPage />));
    await screen.findByText('Run cost');

    expect(
      spy.mock.calls.some(([u]) => String(u).includes('since=2026-09-01&until=2026-09-14'))
    ).toBe(true);
    expect(screen.queryByText(/only offers 7, 30 and 90/)).toBeNull();
    expect(screen.getByLabelText('From date (UTC)')).toBeTruthy();
    // The outcomes card follows the page's range, not its own default.
    await waitFor(() =>
      expect(
        spy.mock.calls.some(
          ([u]) =>
            String(u).includes('/api/v1/pull-requests/outcomes') &&
            String(u).includes('since=2026-09-01&until=2026-09-14')
        )
      ).toBe(true)
    );
  });
});
