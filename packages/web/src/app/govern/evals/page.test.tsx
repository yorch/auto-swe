// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetNavigation } from '@/test/mockNavigation';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

// Recharts needs a laid-out container; record what the chart was handed instead.
const chartData = vi.fn();
vi.mock('@/components/charts/ScorerTrendChart', () => ({
  ScorerTrendChart: ({ data }: { data: unknown }) => {
    chartData(data);
    return <div data-testid="trend-chart" />;
  },
}));

const breakdownSeries = vi.fn();
vi.mock('@/components/charts/ScorerBreakdownChart', () => ({
  ScorerBreakdownChart: ({ series }: { series: unknown }) => {
    breakdownSeries(series);
    return <div data-testid="breakdown-chart" />;
  },
}));
const healthChart = vi.fn();
vi.mock('@/components/charts/SuiteHealthChart', () => ({
  SuiteHealthChart: (props: unknown) => {
    healthChart(props);
    return <div data-testid="health-chart" />;
  },
}));

import GovernEvalsPage from './page';

beforeEach(() => resetNavigation('', '/govern/evals'));
afterEach(() => {
  vi.unstubAllGlobals();
  chartData.mockReset();
  breakdownSeries.mockReset();
  healthChart.mockReset();
});

const day = (date: string, n: number, mean: number | null) => ({ date, mean, n });

function result(over: Record<string, unknown>) {
  return {
    agentKey: null,
    caseId: null,
    createdAt: '2026-09-02T00:00:00.000Z',
    evalRunId: null,
    id: 'res-1',
    metadata: null,
    nodeId: null,
    passed: true,
    rationale: null,
    runId: null,
    scorer: 'gate:runTests',
    scoreType: 'NUMERIC',
    source: 'GATE',
    value: 0.8,
    ...over,
  };
}

function mock(
  trendScorers: () => string[] = () => ['gate:runTests', 'merge'],
  extraTrends: object[] = []
) {
  return setupFetchMock({
    'GET /api/v1/platform/evals': () => ({
      data: [
        {
          caseCount: 4,
          createdAt: '2026-09-01T00:00:00.000Z',
          description: null,
          id: 'ds-1',
          name: 'Bench',
          scope: 'GLOBAL',
          slug: 'bench',
        },
      ],
    }),
    'GET /api/v1/platform/evals/results': () => ({
      data: [
        result({ id: 'r-run', runId: 'aaaaaaaa-1111-4111-8111-111111111111' }),
        result({ evalRunId: 'bbbbbbbb-2222-4222-8222-222222222222', id: 'r-eval' }),
      ],
      meta: { limit: 25, offset: 0, total: 60 },
    }),
    'GET /api/v1/platform/evals/runs': () => ({
      data: [
        {
          baselineRef: 'main',
          candidateRef: 'feat/x',
          datasetId: 'ds-1',
          datasetName: 'Bench',
          datasetSlug: 'bench',
          endedAt: '2026-09-02T01:00:00.000Z',
          id: 'er-1',
          partial: false,
          startedAt: '2026-09-02T00:00:00.000Z',
          status: 'REGRESSION',
          summary: null,
        },
      ],
    }),
    'GET /api/v1/platform/evals/suite-health': () => ({
      data: {
        datasets: [
          {
            cases: 8,
            datasetId: 'ds-1',
            flakeScreened: 7,
            name: 'Bench',
            quarantined: 2,
            slug: 'bench',
            staleRate: 0.25,
          },
        ],
        thresholds: { maxFlakeRate: 0.1, maxStaleRate: 0.1, minKappa: 0.4 },
      },
    }),
    'GET /api/v1/platform/evals/trends': (_body?: unknown) => ({
      data: {
        scorers: [
          {
            daily: [day('2026-09-01', 2, 1), day('2026-09-02', 0, null)],
            mean: 1,
            n: 2,
            scorer: 'gate:runTests',
          },
          {
            daily: [day('2026-09-01', 0, null), day('2026-09-02', 3, 0.25)],
            mean: 0.25,
            n: 3,
            scorer: 'merge',
          },
        ]
          .filter((t) => trendScorers().includes(t.scorer))
          .concat(extraTrends as never[]),
        since: '2026-09-01T00:00:00.000Z',
        until: '2026-09-03T00:00:00.000Z',
        windowDays: 30,
      },
    }),
    'GET /api/v1/workflow-templates': () => ({
      data: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Ticket to PR' }],
    }),
  });
}

const urls = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.map(([u]) => String(u));

describe('GovernEvalsPage', () => {
  it('lists each scorer with window mean, latest day and change, and charts the busiest by default', async () => {
    mock();
    render(withQuery(<GovernEvalsPage />));

    await screen.findByText('Window mean');
    // gate:runTests had no signal on the last day, so "latest" falls back a day.
    expect(screen.getAllByText('0.25')).toHaveLength(2);
    expect(screen.getByText('Change')).toBeTruthy();
    // Nothing fell, so the scorer with the most signals is charted rather than an empty card.
    await screen.findByTestId('trend-chart');
    expect(screen.getByRole('button', { name: 'merge' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('charts the scorer that fell furthest, and shows its change with an arrow', async () => {
    mock(
      () => [],
      [
        {
          daily: [day('2026-09-01', 2, 0.9), day('2026-09-02', 2, 0.6)],
          mean: 0.75,
          n: 4,
          scorer: 'review',
        },
        {
          daily: [day('2026-09-01', 2, 0.5), day('2026-09-02', 2, 0.9)],
          mean: 0.7,
          n: 40,
          scorer: 'merge',
        },
      ]
    );
    render(withQuery(<GovernEvalsPage />));

    await screen.findByText('Window mean');
    await screen.findByTestId('trend-chart');
    expect(screen.getByRole('button', { name: 'review' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(screen.getByText('▼ −0.30')).toBeTruthy();
    expect(screen.getByText('▲ +0.40')).toBeTruthy();
  });

  it('charts a clicked scorer without narrowing the results to it', async () => {
    const spy = mock();
    render(withQuery(<GovernEvalsPage />));

    await screen.findByText('Window mean');
    fireEvent.click(screen.getByRole('button', { name: 'gate:runTests' }));

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'gate:runTests' }).getAttribute('aria-pressed')
      ).toBe('true')
    );
    expect(chartData).toHaveBeenLastCalledWith([
      day('2026-09-01', 2, 1),
      day('2026-09-02', 0, null),
    ]);
    expect(urls(spy).some((u) => u.includes('evals/results?') && u.includes('scorer='))).toBe(
      false
    );
  });

  it('falls back to the default scorer when the chosen one has no signal in the window', async () => {
    resetNavigation('scorer=gone', '/govern/evals');
    mock();
    render(withQuery(<GovernEvalsPage />));
    await screen.findByText('Window mean');
    await screen.findByTestId('trend-chart');
    expect(screen.getByRole('button', { name: 'merge' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the latest benchmark runs with a plain verdict and no kappa footnote', async () => {
    mock();
    render(withQuery(<GovernEvalsPage />));

    await screen.findByText('Latest eval runs');
    expect(await screen.findByText('Regression')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Bench/ })).toBeTruthy();
    expect(screen.queryByText(/kappa/)).toBeNull();
  });

  it('switches the trend window', async () => {
    const spy = mock();
    render(withQuery(<GovernEvalsPage />));
    await screen.findByText('Window mean');

    fireEvent.click(screen.getByRole('button', { name: '90d' }));

    await waitFor(() => expect(urls(spy).some((u) => u.includes('trends?window=90'))).toBe(true));
  });

  it('links results to their run or eval run, pages them, and links datasets', async () => {
    const spy = mock();
    render(withQuery(<GovernEvalsPage />));

    await screen.findByText('run aaaaaaaa');
    const runLink = screen.getByRole('link', { name: 'run aaaaaaaa' });
    expect(runLink.getAttribute('href')).toBe('/runs/aaaaaaaa-1111-4111-8111-111111111111');
    expect(screen.getByRole('link', { name: 'eval run bbbbbbbb' }).getAttribute('href')).toBe(
      '/govern/evals/runs/bbbbbbbb-2222-4222-8222-222222222222'
    );
    expect(screen.getByRole('link', { name: /bench/ }).getAttribute('href')).toBe(
      '/govern/evals/datasets/ds-1'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() =>
      expect(urls(spy).some((u) => u.includes('evals/results?') && u.includes('offset=25'))).toBe(
        true
      )
    );
  });

  it('charts the suite health of every dataset against the stale-rate ceiling', async () => {
    mock();
    render(withQuery(<GovernEvalsPage />));

    await screen.findByTestId('health-chart');
    expect(healthChart).toHaveBeenLastCalledWith({
      datasets: [expect.objectContaining({ slug: 'bench', staleRate: 0.25 })],
      maxStaleRate: 0.1,
    });
  });

  it('asks for a breakdown and a template when they are chosen', async () => {
    const spy = mock();
    render(withQuery(<GovernEvalsPage />));
    await screen.findByText('Window mean');

    fireEvent.click(screen.getByRole('button', { name: 'Judge model' }));

    await waitFor(() =>
      expect(urls(spy).some((u) => u.includes('trends?') && u.includes('by=judgeModel'))).toBe(true)
    );
    // The breakdown names the dimension in the table.
    expect(screen.getAllByText('Judge model').length).toBeGreaterThan(1);
  });

  it('charts a split scorer as one series per breakdown value, with the none bucket named', async () => {
    const series = (breakdown: string | null, mean: number) => ({
      breakdown,
      daily: [day('2026-09-01', 2, mean)],
      mean,
      n: 2,
      scorer: 'judge',
    });
    mock(() => [], [series('a/x', 1), series(null, 0.5)]);
    render(withQuery(<GovernEvalsPage />));
    await screen.findByText('Window mean');

    fireEvent.click(screen.getAllByRole('button', { name: 'judge' })[0] as HTMLElement);

    await screen.findByTestId('breakdown-chart');
    expect(breakdownSeries).toHaveBeenLastCalledWith([
      expect.objectContaining({ label: 'a/x' }),
      expect.objectContaining({ label: '(none)' }),
    ]);
  });
});
