// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import EvalDatasetPage from './page';

afterEach(() => vi.unstubAllGlobals());

const DS_ID = '11111111-1111-4111-8111-111111111111';

/** A promise React's `use` reads synchronously, as it does one it has already seen settle. */
function resolvedParams<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), { status: 'fulfilled', value });
}

describe('EvalDatasetPage', () => {
  it('lists the dataset cases and links each harness run to its detail', async () => {
    const spy = setupFetchMock({
      [`GET /api/v1/platform/evals/${DS_ID}`]: () => ({
        data: {
          caseCount: 1,
          cases: [
            {
              baselineSha: 'abcdef1234567890',
              createdAt: '2026-09-01T00:00:00.000Z',
              datasetId: DS_ID,
              flakeRuns: 5,
              flakeScreened: true,
              goldenTest: 'yarn test auth',
              id: 'case-1',
              input: {},
              reference: null,
              repoUrl: 'https://github.com/acme/api',
              tags: ['auth'],
            },
          ],
          createdAt: '2026-09-01T00:00:00.000Z',
          description: 'Auth regressions',
          id: DS_ID,
          name: 'Auth bench',
          scope: 'GLOBAL',
          slug: 'auth-bench',
        },
      }),
      'GET /api/v1/platform/evals/runs': () => ({
        data: [
          {
            baselineRef: 'main',
            candidateRef: 'feat/x',
            datasetId: DS_ID,
            endedAt: null,
            id: 'run-1',
            startedAt: '2026-09-02T00:00:00.000Z',
            status: 'RUNNING',
            summary: null,
          },
        ],
        meta: { limit: 20, offset: 0, total: 1 },
      }),
    });
    render(withQuery(<EvalDatasetPage params={resolvedParams({ id: DS_ID })} />));

    expect(await screen.findByText('Auth bench')).toBeTruthy();
    expect(await screen.findByText('https://github.com/acme/api')).toBeTruthy();
    expect(screen.getByText('screened (5 runs)')).toBeTruthy();
    expect(await screen.findByText('feat/x')).toBeTruthy();
    const runLink = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href') === '/govern/evals/runs/run-1');
    expect(runLink).toBeTruthy();
    expect(spy.mock.calls.some(([u]) => String(u).includes(`evals/runs?datasetId=${DS_ID}`))).toBe(
      true
    );
  });
});
