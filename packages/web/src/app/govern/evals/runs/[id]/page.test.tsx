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

function renderPage(
  summary: unknown,
  status = 'REGRESSION',
  runtimes: { baselineRuntime?: string | null; candidateRuntime?: string | null } = {},
  results: unknown[] = []
) {
  const spy = setupFetchMock({
    [`GET /api/v1/platform/evals/runs/${RUN_ID}`]: () => ({
      data: {
        baselineRef: 'main',
        baselineRuntime: null,
        candidateRef: 'feat/x',
        candidateRuntime: null,
        ...runtimes,
        datasetId: 'ds-1',
        endedAt: '2026-09-02T00:00:00.000Z',
        id: RUN_ID,
        startedAt: '2026-09-01T00:00:00.000Z',
        status,
        summary,
      },
    }),
    'GET /api/v1/platform/evals/results': () => ({
      data: results,
      meta: { limit: 25, offset: 0, total: results.length },
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
  it('names each side’s runtime override and the runtimes the cases ran on', async () => {
    renderPage(
      {
        byTag: {},
        overall: delta(0, -0.1, 0.1),
        regression: false,
        runtimes: { baseline: ['mastra'], candidate: ['claude-code'] },
        summary: 'pass-rate 80% → 80%',
      },
      'SUCCESS',
      { baselineRuntime: 'mastra', candidateRuntime: 'claude-code' },
      [
        {
          agentKey: null,
          caseId: 'c1',
          createdAt: '2026-09-01T00:10:00.000Z',
          evalRunId: RUN_ID,
          id: 'res-1',
          metadata: { baselineRuntime: 'mastra', tags: [] },
          nodeId: null,
          passed: true,
          rationale: null,
          runId: null,
          runtime: 'claude-code',
          scorer: 'gate:runTests',
          scoreType: 'BOOLEAN',
          source: 'GATE',
          value: 1,
        },
      ]
    );
    expect(
      await screen.findByText(/feat\/x on Claude Code harness vs main on Mastra loop/)
    ).toBeTruthy();
    expect(
      screen.getByText('Ran on: candidate Claude Code harness, baseline Mastra loop')
    ).toBeTruthy();
    expect(await screen.findByText(/vs Mastra loop$/)).toBeTruthy();
  });

  it('shows the paired verdict overall and per tag, and scopes results to the run', async () => {
    const spy = renderPage({
      byTag: { auth: delta(-0.2, -0.35, -0.05) },
      overall: delta(-0.1, -0.2, 0),
      regression: false,
      summary: 'pass-rate 80% → 70% — no significant regression',
    });

    expect(await screen.findByText('pass-rate 80% → 70% — no significant regression')).toBeTruthy();
    expect(screen.getByText('Overall')).toBeTruthy();
    expect(screen.getByText('Tag: auth')).toBeTruthy();
    expect(screen.getByText('−20.0 pts')).toBeTruthy();
    // The one-line verdict leads, in words, with the likely range spelled out.
    expect(
      screen.getByText(
        /Candidate is 10\.0 points worse than the baseline, but the difference is within the margin of error/
      )
    ).toBeTruthy();
    // A column header (narrow screens also repeat it as each stacked cell's caption).
    expect(screen.getByRole('columnheader', { name: 'Likely range' })).toBeTruthy();
    // The back link names the dataset it returns to ("Dataset" when the run has no name for it).
    expect(screen.getByRole('link', { name: 'Dataset' }).getAttribute('href')).toBe(
      '/govern/evals/datasets/ds-1'
    );
    await waitFor(() =>
      expect(
        spy.mock.calls.some(([u]) => String(u).includes(`evals/results?evalRunId=${RUN_ID}`))
      ).toBe(true)
    );
  });

  it('marks a verdict the budget cut short as partial', async () => {
    renderPage(
      {
        byTag: {},
        overall: delta(0, -0.1, 0.1),
        partial: {
          completedCases: 1,
          error: 'Runless workflow budget exceeded',
          notRunCaseIds: ['c2'],
          reason: 'budget',
          totalCases: 2,
        },
        regression: false,
        summary: 'pass-rate 80% → 80% — no significant regression',
      },
      'SUCCESS'
    );
    expect(
      await screen.findByText(
        'Partial: the budget stopped this run after 1 of 2 cases; the verdict covers only those. Runless workflow budget exceeded'
      )
    ).toBeTruthy();
  });

  it('names the organization budget when that is what cut the verdict short', async () => {
    renderPage(
      {
        byTag: {},
        overall: delta(0, -0.1, 0.1),
        partial: {
          completedCases: 1,
          error: 'Organization monthly budget exhausted',
          notRunCaseIds: ['c2'],
          reason: 'org_budget',
          totalCases: 2,
        },
        regression: false,
        summary: 'pass-rate 80% → 80% — no significant regression',
      },
      'SUCCESS'
    );
    expect(
      await screen.findByText(/the organization's monthly budget stopped this run after 1 of 2/)
    ).toBeTruthy();
  });

  it('shows no partial marker on a complete verdict', async () => {
    renderPage({
      byTag: {},
      overall: delta(0, -0.1, 0.1),
      regression: false,
      summary: 'complete verdict',
    });
    expect(await screen.findByText('complete verdict')).toBeTruthy();
    expect(screen.queryByText(/^Partial:/)).toBeNull();
  });

  it('shows a start failure stored on the run', async () => {
    renderPage({ error: 'temporal unavailable' }, 'FAILED');
    expect(await screen.findByText('temporal unavailable')).toBeTruthy();
  });
});
