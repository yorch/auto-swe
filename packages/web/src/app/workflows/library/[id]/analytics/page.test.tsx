// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';

vi.mock('next/navigation', () => ({
  usePathname: () => '/workflows/library/t1/analytics',
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
  perVersionCounts: [],
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
    expect(link.getAttribute('href')).toBe(`/workflows/library/${ID}/runs?failedStep=runTests`);
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

  it('names outcomes in words', async () => {
    renderPage();
    expect(await screen.findByText('Pr opened')).toBeTruthy();
  });
});
