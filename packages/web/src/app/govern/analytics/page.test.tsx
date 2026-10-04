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

beforeEach(() => resetNavigation('', '/govern/analytics'));
afterEach(() => {
  vi.unstubAllGlobals();
  chartData.mockReset();
});

const analytics = {
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
  ],
  perOutcome: [
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

function mock() {
  return setupFetchMock({
    'GET /api/v1/workflow-templates/analytics': () => ({ data: analytics }),
  });
}

describe('GlobalAnalyticsPage', () => {
  it('leads with four headline figures, each against the previous window', async () => {
    mock();
    render(withQuery(<GlobalAnalyticsPage />));

    expect(await screen.findByText('Run cost')).toBeTruthy();
    expect(screen.getByText('Run cost')).toBeTruthy();
    expect(screen.getByText('Time saved (estimate)')).toBeTruthy();
    // Cost fell by half, which is good news, and the rate fell 12 points.
    expect(screen.getByText(/−50% vs previous 30 days/)).toBeTruthy();
    expect(screen.getByText(/−12\.2 pts vs previous 30 days/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See all spend' }).getAttribute('href')).toBe(
      '/govern/usage'
    );
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

  it('asks for the chosen window and keeps it in the URL', async () => {
    const spy = mock();
    render(withQuery(<GlobalAnalyticsPage />));
    await screen.findByText('Run cost');

    fireEvent.click(screen.getByRole('button', { name: '90d' }));

    await waitFor(() =>
      expect(spy.mock.calls.some(([u]) => String(u).includes('window=90'))).toBe(true)
    );
  });
});
