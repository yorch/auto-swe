// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import EvalRunPage from './page';

afterEach(() => vi.unstubAllGlobals());

const RUN_ID = 'bbbbbbbb-2222-4222-8222-222222222222';

/** A promise React's `use` reads synchronously, as it does one it has already seen settle. */
function resolvedParams<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), { status: 'fulfilled', value });
}

function renderPage(summary: unknown, status = 'REGRESSION') {
  const spy = setupFetchMock({
    [`GET /api/v1/platform/evals/runs/${RUN_ID}`]: () => ({
      data: {
        baselineRef: 'main',
        candidateRef: 'feat/x',
        datasetId: 'ds-1',
        endedAt: '2026-09-02T00:00:00.000Z',
        id: RUN_ID,
        startedAt: '2026-09-01T00:00:00.000Z',
        status,
        summary,
      },
    }),
    'GET /api/v1/platform/evals/results': () => ({
      data: [],
      meta: { limit: 25, offset: 0, total: 0 },
    }),
  });
  render(
    withQuery(
      <Suspense fallback={null}>
        <EvalRunPage params={resolvedParams({ id: RUN_ID })} />
      </Suspense>
    )
  );
  return spy;
}

const delta = (d: number, lo: number, hi: number) => ({
  baselineRate: 0.8,
  candidateRate: 0.8 + d,
  ci95: [lo, hi],
  delta: d,
  n: 10,
  se: 0.05,
});

describe('EvalRunPage', () => {
  it('shows the paired verdict overall and per tag, and scopes results to the run', async () => {
    const spy = renderPage({
      byTag: { auth: delta(-0.2, -0.35, -0.05) },
      overall: delta(-0.1, -0.2, 0),
      regression: false,
      summary: 'pass-rate 80% → 70% — no significant regression',
    });

    expect(await screen.findByText('pass-rate 80% → 70% — no significant regression')).toBeTruthy();
    expect(screen.getByText('overall')).toBeTruthy();
    expect(screen.getByText('tag: auth')).toBeTruthy();
    expect(screen.getByText('-20.0pp')).toBeTruthy();
    expect(screen.getByRole('link', { name: '← Dataset' }).getAttribute('href')).toBe(
      '/govern/evals/datasets/ds-1'
    );
    await waitFor(() =>
      expect(
        spy.mock.calls.some(([u]) => String(u).includes(`evals/results?evalRunId=${RUN_ID}`))
      ).toBe(true)
    );
  });

  it('shows a start failure stored on the run', async () => {
    renderPage({ error: 'temporal unavailable' }, 'FAILED');
    expect(await screen.findByText('temporal unavailable')).toBeTruthy();
  });
});
