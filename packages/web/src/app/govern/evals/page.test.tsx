// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';

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
  it('lists each scorer with window and latest means, and charts none until one is picked', async () => {
    mock();
    render(withQuery(<GovernEvalsPage />));

    await screen.findByText('Window mean');
    // gate:runTests had no signal on the last day, so "latest" falls back a day.
    expect(screen.getAllByText('0.25')).toHaveLength(2);
    // The results show every scorer, so no scorer's chart may stand in for them.
    expect(screen.getByText(/Pick a scorer to chart/)).toBeTruthy();
    expect(screen.queryByTestId('trend-chart')).toBeNull();
    for (const name of ['gate:runTests', 'merge']) {
      expect(screen.getByRole('button', { name }).getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('charts a clicked scorer and filters the results table to it', async () => {
    const spy = mock();
    render(withQuery(<GovernEvalsPage />));

    await screen.findByText('Window mean');
    fireEvent.click(screen.getByRole('button', { name: 'merge' }));

    await screen.findByTestId('trend-chart');
    expect(screen.getByRole('button', { name: 'merge' }).getAttribute('aria-pressed')).toBe('true');
    expect(chartData).toHaveBeenLastCalledWith([
      day('2026-09-01', 0, null),
      day('2026-09-02', 3, 0.25),
    ]);
    await waitFor(() =>
      expect(
        urls(spy).some((u) => u.includes('evals/results?') && u.includes('scorer=merge'))
      ).toBe(true)
    );
  });

  it('names the selected scorer instead of charting another when it has no trend', async () => {
    let scorers = ['gate:runTests', 'merge'];
    mock(() => scorers);
    render(withQuery(<GovernEvalsPage />));
    await screen.findByText('Window mean');
    fireEvent.click(screen.getByRole('button', { name: 'merge' }));
    await screen.findByTestId('trend-chart');

    // A window in which merge recorded nothing.
    scorers = ['gate:runTests'];
    fireEvent.click(screen.getByRole('button', { name: '90d' }));

    await screen.findByText('No merge signals in this window.');
    expect(screen.queryByTestId('trend-chart')).toBeNull();
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
