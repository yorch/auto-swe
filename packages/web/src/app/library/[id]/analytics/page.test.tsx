// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';

vi.mock('next/navigation', () => ({
  usePathname: () => '/library/t1/analytics',
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import TemplateAnalyticsPage from './page';

afterEach(() => vi.unstubAllGlobals());

const ID = '11111111-1111-4111-8111-111111111111';

function resolvedParams<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), { status: 'fulfilled', value });
}

const stats = {
  agentErrorRate: null,
  autonomyRate: 0.5,
  avgCostPerRun: 1,
  estimatedHumanTimeSavedTotal: null,
  failed: 2,
  humanReviewRate: 0.1,
  isTruncated: false,
  p50DurationMs: 1000,
  p95DurationMs: 2000,
  perOutcome: [{ outcomeType: 'PR_OPENED', runCount: 5, totalCost: 5 }],
  perStepFailureRates: [
    { failed: 0, failureRate: 0, nodeId: 'lint', total: 12 },
    { failed: 3, failureRate: 0.3, nodeId: 'runTests', total: 10 },
    { failed: 1, failureRate: 0.5, nodeId: 'rareStep', total: 2 },
  ],
  perVersion: [
    {
      avgCostPerRun: 1,
      mergeRate: 0.5,
      mergeRateCi95: [0.2, 0.8],
      p50DurationMs: 1000,
      prMerged: 1,
      prOpen: 1,
      prOpened: 2,
      runs: 5,
      succeeded: 4,
      successRate: 0.8,
      successRateCi95: [0.4, 0.95],
      version: 1,
    },
    {
      avgCostPerRun: 2,
      mergeRate: null,
      mergeRateCi95: null,
      p50DurationMs: 2000,
      prMerged: 0,
      prOpen: 0,
      prOpened: 0,
      runs: 5,
      succeeded: 3,
      successRate: 0.6,
      successRateCi95: [0.25, 0.85],
      version: 2,
    },
  ],
  perVersionCounts: [
    { count: 5, version: 1 },
    { count: 5, version: 2 },
  ],
  significanceHint: {
    isSignificant: true,
    nA: 12,
    nB: 40,
    pValue: 0.01,
    successRateA: 0.5,
    successRateB: 0.9,
    versionA: 1,
    versionB: 2,
    zScore: 2.5,
  },
  succeeded: 8,
  successRate: 0.8,
  totalCost: 5,
  totalRuns: 10,
  windowDays: 30,
};

function renderPage(over: Record<string, unknown> = {}) {
  setupFetchMock({
    [`GET /api/v1/workflow-templates/${ID}`]: () => ({
      data: {
        activeVersion: 1,
        activeVersionSpec: { spec: { nodes: { runTests: { title: 'Run the test suite' } } } },
        experimentVersion: 2,
        id: ID,
        name: 'Ticket to PR',
        versions: [],
      },
    }),
    [`GET /api/v1/workflow-templates/${ID}/analytics`]: () => ({ data: { ...stats, ...over } }),
  });
  render(
    withQuery(
      <Suspense fallback={null}>
        <TemplateAnalyticsPage params={resolvedParams({ id: ID })} />
      </Suspense>
    )
  );
}

describe('TemplateAnalyticsPage', () => {
  it('shows an empty state instead of a wall of zero tiles when there are no runs', async () => {
    renderPage({ perStepFailureRates: [], significanceHint: null, totalRuns: 0 });
    expect(await screen.findByText('No runs in the last 30 days')).toBeTruthy();
    expect(screen.queryByText('Avg cost / run')).toBeNull();
  });

  it('lists steps once, by title, hides thin samples, and links failures to the runs', async () => {
    renderPage();
    const link = await screen.findByRole('link', { name: 'Run the test suite' });
    expect(link.getAttribute('href')).toBe(`/library/${ID}/runs?failedStep=runTests`);
    // An untitled step reads as words, not as its id.
    expect(screen.getByText('Lint')).toBeTruthy();
    // Two runs is below the default minimum, so that step is hidden and said to be.
    expect(screen.queryByText('Rare step')).toBeNull();
    expect(screen.getByText(/1 step with fewer than 5 runs hidden/)).toBeTruthy();
  });

  it('names the better version, and warns when one side has too few runs', async () => {
    renderPage();
    expect(await screen.findByText(/Significant difference — v2 is better/)).toBeTruthy();
    expect(screen.getByText(/fewer than 30 runs, so this comparison is unreliable/)).toBeTruthy();
  });

  it('offers a definition beside each derived metric', async () => {
    renderPage();
    await screen.findByText('Success rate');
    for (const name of [
      'About Success rate',
      'About p50 duration',
      'About p95 duration',
      'About Est. time saved (successful runs)',
      'About Autonomy rate',
      'About Human review rate',
    ]) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });

  it('names outcomes in words', async () => {
    renderPage();
    expect(await screen.findByText('Pr opened')).toBeTruthy();
  });

  it('shows per-version outcome and merge-rate confidence intervals', async () => {
    renderPage();
    expect(await screen.findByText('Success rate (95% CI)')).toBeTruthy();
    expect(screen.getByText('Merge rate (resolved PRs, 95% CI)')).toBeTruthy();
    expect(
      screen.getAllByRole('row').some((row) => row.textContent?.includes('80.0% (40.0%–95.0%)'))
    ).toBe(true);
    expect(
      screen
        .getAllByRole('row')
        .some(
          (row) =>
            row.textContent?.includes('1/1 resolved') &&
            row.textContent.includes('1 open') &&
            row.textContent.includes('50.0% (20.0%–80.0%)')
        )
    ).toBe(true);
  });
});
