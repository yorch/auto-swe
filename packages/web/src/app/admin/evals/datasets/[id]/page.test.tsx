// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import EvalDatasetPage from './page';

afterEach(() => vi.unstubAllGlobals());

// jsdom implements <dialog> without showModal()/close(); stand in for the browser's.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

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
          caseCount: 2,
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
            {
              baselineSha: 'abcdef1234567890',
              createdAt: '2026-09-01T00:00:00.000Z',
              datasetId: DS_ID,
              flakeRuns: 3,
              flakeScreened: false,
              goldenTest: 'yarn test web',
              id: 'case-2',
              input: {},
              reference: null,
              repoUrl: 'https://github.com/acme/web',
              tags: [],
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
    expect(screen.getByText('Checked (5 runs)')).toBeTruthy();
    expect(screen.getByText('Flaky (failed a 3-run check)')).toBeTruthy();
    expect(await screen.findByText('feat/x')).toBeTruthy();
    const runLink = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href') === '/admin/evals/runs/run-1');
    expect(runLink).toBeTruthy();
    expect(spy.mock.calls.some(([u]) => String(u).includes(`evals/runs?datasetId=${DS_ID}`))).toBe(
      true
    );
  });

  it('re-checks a flaky case after confirmation and says the check started', async () => {
    const flaky = {
      baselineSha: 'abcdef1234567890',
      createdAt: '2026-09-01T00:00:00.000Z',
      datasetId: DS_ID,
      flakeRuns: 3,
      flakeScreened: false,
      goldenTest: 'yarn test web',
      id: 'case-2',
      input: {},
      reference: null,
      repoUrl: 'https://github.com/acme/web',
      tags: [],
    };
    const spy = setupFetchMock({
      [`GET /api/v1/platform/evals/${DS_ID}`]: () => ({
        data: {
          caseCount: 1,
          cases: [flaky],
          createdAt: '2026-09-01T00:00:00.000Z',
          description: null,
          id: DS_ID,
          name: 'Web bench',
          scope: 'GLOBAL',
          slug: 'web-bench',
        },
      }),
      [`POST /api/v1/platform/evals/${DS_ID}/cases/case-2/rescreen`]: () => ({
        data: { reset: 1, screenStarted: true },
      }),
      'GET /api/v1/platform/evals/runs': () => ({
        data: [],
        meta: { limit: 20, offset: 0, total: 0 },
      }),
    });
    render(withQuery(<EvalDatasetPage params={resolvedParams({ id: DS_ID })} />));

    fireEvent.click(await screen.findByRole('button', { name: 'Re-check case case-2' }));
    expect(await screen.findByText('Re-check this case?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }));

    expect(await screen.findByText('1 case reset; the stability check has started.')).toBeTruthy();
    expect(
      spy.mock.calls.some(
        ([u, init]) =>
          String(u).endsWith(`/evals/${DS_ID}/cases/case-2/rescreen`) &&
          (init as RequestInit | undefined)?.method === 'POST'
      )
    ).toBe(true);
  });

  it('shows each case stack (node when unset) and changes one after confirmation', async () => {
    const base = {
      baselineSha: 'abcdef1234567890',
      createdAt: '2026-09-01T00:00:00.000Z',
      datasetId: DS_ID,
      flakeRuns: 5,
      flakeScreened: true,
      goldenTest: 'yarn test',
      input: {},
      reference: null,
      tags: [],
    };
    const spy = setupFetchMock({
      [`GET /api/v1/platform/evals/${DS_ID}`]: () => ({
        data: {
          caseCount: 2,
          cases: [
            { ...base, id: 'case-1', repoUrl: 'https://github.com/acme/api', stack: null },
            { ...base, id: 'case-2', repoUrl: 'https://github.com/acme/svc', stack: 'python' },
          ],
          createdAt: '2026-09-01T00:00:00.000Z',
          description: null,
          id: DS_ID,
          name: 'Stack bench',
          scope: 'GLOBAL',
          slug: 'stack-bench',
        },
      }),
      [`PATCH /api/v1/platform/evals/${DS_ID}/cases/case-1`]: () => ({
        data: { ...base, id: 'case-1', stack: 'jvm' },
      }),
      'GET /api/v1/platform/evals/runs': () => ({
        data: [],
        meta: { limit: 20, offset: 0, total: 0 },
      }),
    });
    render(withQuery(<EvalDatasetPage params={resolvedParams({ id: DS_ID })} />));

    const unset = await screen.findByRole('button', { name: /Stack of case case-1/ });
    expect(unset.textContent).toContain('node');
    expect(screen.getByRole('button', { name: /Stack of case case-2/ }).textContent).toContain(
      'python'
    );

    fireEvent.click(unset);
    fireEvent.click(screen.getByRole('option', { name: 'jvm' }));
    expect(await screen.findByText("Change this case's stack?")).toBeTruthy();
    expect(
      screen.getByText(/moves to the jvm environment and goes back to "Not checked yet"/)
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change stack' }));

    expect(
      await screen.findByText('Stack changed; the case is checked again on the new stack.')
    ).toBeTruthy();
    const bodies = spy.mock.calls
      .filter(
        ([u, init]) =>
          String(u).endsWith(`/evals/${DS_ID}/cases/case-1`) &&
          (init as RequestInit | undefined)?.method === 'PATCH'
      )
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(bodies).toEqual([{ stack: 'jvm' }]);
  });

  it('pages through a long case list and names the CLI command when there are no runs', async () => {
    const cases = Array.from({ length: 30 }, (_, i) => ({
      baselineSha: 'abcdef1234567890',
      createdAt: '2026-09-01T00:00:00.000Z',
      datasetId: DS_ID,
      flakeRuns: 0,
      flakeScreened: false,
      goldenTest: 'yarn test',
      id: `case-${i}`,
      input: {},
      reference: null,
      repoUrl: `https://github.com/acme/repo-${i}`,
      tags: [],
    }));
    setupFetchMock({
      [`GET /api/v1/platform/evals/${DS_ID}`]: () => ({
        data: {
          caseCount: 30,
          cases,
          createdAt: '2026-09-01T00:00:00.000Z',
          description: null,
          id: DS_ID,
          name: 'Big bench',
          scope: 'GLOBAL',
          slug: 'big-bench',
        },
      }),
      'GET /api/v1/platform/evals/runs': () => ({
        data: [],
        meta: { limit: 20, offset: 0, total: 0 },
      }),
    });
    render(withQuery(<EvalDatasetPage params={resolvedParams({ id: DS_ID })} />));

    expect(await screen.findByText('https://github.com/acme/repo-0')).toBeTruthy();
    expect(screen.queryByText('https://github.com/acme/repo-25')).toBeNull();
    expect(screen.getByText(/auto-swe evals run big-bench/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('https://github.com/acme/repo-25')).toBeTruthy();
  });
});
