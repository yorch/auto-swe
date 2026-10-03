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

import GovernEvalsPage from './page';

afterEach(() => {
  vi.unstubAllGlobals();
  chartData.mockReset();
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

function mock() {
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
    'GET /api/v1/platform/evals/trends': () => ({
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
        ],
        since: '2026-09-01T00:00:00.000Z',
        until: '2026-09-03T00:00:00.000Z',
        windowDays: 30,
      },
    }),
  });
}

const urls = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.map(([u]) => String(u));

describe('GovernEvalsPage', () => {
  it('charts the first scorer by day and lists each scorer with window and latest means', async () => {
    mock();
    render(withQuery(<GovernEvalsPage />));

    await screen.findByTestId('trend-chart');
    expect(chartData).toHaveBeenLastCalledWith([
      day('2026-09-01', 2, 1),
      day('2026-09-02', 0, null),
    ]);
    // gate:runTests had no signal on the last day, so "latest" falls back a day.
    expect(screen.getByRole('button', { name: 'gate:runTests' })).toBeTruthy();
    expect(screen.getAllByText('0.25')).toHaveLength(2);
  });

  it('charts a clicked scorer and filters the results table to it', async () => {
    const spy = mock();
    render(withQuery(<GovernEvalsPage />));

    await screen.findByTestId('trend-chart');
    fireEvent.click(screen.getByRole('button', { name: 'merge' }));

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

  it('switches the trend window', async () => {
    const spy = mock();
    render(withQuery(<GovernEvalsPage />));
    await screen.findByTestId('trend-chart');

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
});
