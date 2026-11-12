// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import LessonsPage from './page';

const lesson = (over: Record<string, unknown> = {}) => ({
  confidence: null,
  consolidatedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  failureType: 'CI_FAILURE',
  flagCount: 0,
  id: 'l1',
  lessonSummary: 'Run migrations before deploying',
  metadata: null,
  myFlag: null,
  quarantinedAt: null,
  quarantinedById: null,
  quarantineReason: null,
  quarantineSource: null,
  rationale: null,
  repository: { id: 'r1', organizationName: 'acme', repoName: 'api' },
  workflow: null,
  workflowRunId: null,
  ...over,
});

function mock(rows: unknown[], managedRepoIds?: string[]) {
  return setupFetchMock({
    '/api/v1/admin/config/consolidation': () => ({ data: null }),
    'DELETE /api/v1/lessons/l1/flags': () => ({ data: { cleared: 1 } }),
    'DELETE /api/v1/lessons/l1/flags/mine': () => ({ data: { withdrawn: true } }),
    'GET /api/v1/lessons': () => ({
      data: rows,
      meta: { limit: 20, managedRepoIds, offset: 0, total: rows.length },
    }),
    'GET /api/v1/lessons/stats': () => ({ data: [] }),
    'GET /api/v1/repositories': () => ({
      data: [{ id: 'r1', organizationName: 'acme', repoName: 'api', type: 'git_repo' }],
      meta: { limit: 100, offset: 0, total: 1 },
    }),
    'POST /api/v1/lessons/consolidate': () => ({ data: { workflowId: 'wf-1' } }),
    'POST /api/v1/lessons/l1/flags': () => ({ data: { flagged: true } }),
    'POST /api/v1/lessons/l1/quarantine': () => ({ data: {} }),
    'POST /api/v1/lessons/l1/restore': () => ({ data: {} }),
  });
}

beforeEach(() => {
  stubDialogPrototype();
  useAuthStore.setState({ isAuthenticated: true, user: { role: 'ADMIN', sub: 'me' } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ isAuthenticated: false, user: null });
});

describe('LessonsPage', () => {
  it('lists a lesson whose repository has been deleted instead of crashing', async () => {
    mock([lesson(), lesson({ id: 'l2', lessonSummary: 'Pin the base image', repository: null })]);
    render(withQuery(<LessonsPage />));
    expect(await screen.findByText('Pin the base image')).toBeTruthy();
    expect(screen.getByText('Deleted repository')).toBeTruthy();
    const kept = screen.getByText('Run migrations before deploying').closest('li') as HTMLElement;
    expect(within(kept).getByText('acme/api')).toBeTruthy();
  });

  it('gives an admin the delete control and the per-repository stats', async () => {
    const fetchSpy = mock([lesson()]);
    render(withQuery(<LessonsPage />));
    expect(await screen.findByText('Run migrations before deploying')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete lesson' })).toBeTruthy();
    expect(await screen.findByText('Lessons by repository')).toBeTruthy();
    expect(requestedPaths(fetchSpy)).toContain('/api/v1/lessons/stats');
  });
});

describe('LessonsPage delete confirmation', () => {
  it('quotes a long lesson truncated, so the confirm button stays in reach', async () => {
    const long = `${'word '.repeat(80)}END`;
    mock([lesson({ lessonSummary: long })]);
    render(withQuery(<LessonsPage />));
    await screen.findByText(long);
    fireEvent.click(screen.getByRole('button', { name: 'Delete lesson' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/END/)).toBeNull();
    expect(within(dialog).getByText(/…$/)).toBeTruthy();
  });
});

/** Every path the page fetched, query strings dropped. */
function requestedPaths(spy: ReturnType<typeof setupFetchMock>): string[] {
  return spy.mock.calls.map(
    ([url]) =>
      String(url)
        .replace(/^https?:\/\/[^/]+/, '')
        .split('?')[0]
  );
}

describe('LessonsPage (engineer)', () => {
  beforeEach(() => {
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'ENGINEER', sub: 'me' } });
  });

  it('lists lessons read-only and never asks for the admin-only stats or config', async () => {
    const fetchSpy = mock([lesson()]);
    render(withQuery(<LessonsPage />));
    expect(await screen.findByText('Run migrations before deploying')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete lesson' })).toBeNull();
    expect(screen.queryByRole('button', { name: /consolidate all now/i })).toBeNull();
    expect(screen.queryByText('Lessons by repository')).toBeNull();
    const paths = requestedPaths(fetchSpy);
    expect(paths).not.toContain('/api/v1/lessons/stats');
    expect(paths).not.toContain('/api/v1/admin/config/consolidation');
  });

  it('offers their own repositories as the filter', async () => {
    mock([lesson()]);
    render(withQuery(<LessonsPage />));
    await screen.findByText('Run migrations before deploying');
    fireEvent.click(screen.getByRole('button', { name: 'Show options' }));
    expect(await screen.findByRole('option', { name: 'acme/api' })).toBeTruthy();
  });

  it('shows the outcome, a low-confidence label and a link to the source run', async () => {
    mock([
      lesson({
        confidence: 0.3,
        metadata: { outcome: 'CI_FAILED' },
        workflowRunId: '99999999-9999-4999-8999-999999999999',
      }),
    ]);
    render(withQuery(<LessonsPage />));
    expect(await screen.findByText('Ci failed')).toBeTruthy();
    expect(screen.getByText('Low confidence')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Source run' }).getAttribute('href')).toBe(
      '/runs/99999999-9999-4999-8999-999999999999'
    );
  });

  it('does not label a lesson the writer graded confidently', async () => {
    mock([lesson({ confidence: 0.9 })]);
    render(withQuery(<LessonsPage />));
    expect(await screen.findByText('Run migrations before deploying')).toBeTruthy();
    expect(screen.queryByText('Low confidence')).toBeNull();
  });
});

describe('LessonsPage (lead of the repository team)', () => {
  beforeEach(() => {
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'ENGINEER', sub: 'me' } });
  });

  it('offers delete only on lessons of repositories they lead', async () => {
    mock(
      [
        lesson(),
        lesson({
          id: 'l2',
          lessonSummary: 'Shared repo lesson',
          repository: { id: 'r2', organizationName: 'acme', repoName: 'web' },
        }),
      ],
      ['r1']
    );
    render(withQuery(<LessonsPage />));
    const led = (await screen.findByText('Run migrations before deploying')).closest(
      'li'
    ) as HTMLElement;
    expect(within(led).getByRole('button', { name: 'Delete lesson' })).toBeTruthy();
    const other = screen.getByText('Shared repo lesson').closest('li') as HTMLElement;
    expect(within(other).queryByRole('button', { name: 'Delete lesson' })).toBeNull();
  });

  it('consolidates the repository they filtered to', async () => {
    const fetchSpy = mock([lesson()], ['r1']);
    render(withQuery(<LessonsPage />));
    await screen.findByText('Run migrations before deploying');
    expect(screen.queryByRole('button', { name: /consolidate this repository/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show options' }));
    fireEvent.click(await screen.findByRole('option', { name: 'acme/api' }));
    fireEvent.click(await screen.findByRole('button', { name: /consolidate this repository/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run consolidation' }));

    expect(await screen.findByText(/Consolidation started for acme\/api/)).toBeTruthy();
    expect(bodyOf(fetchSpy, '/api/v1/lessons/consolidate')).toEqual({ repoId: 'r1' });
  });
});

describe('LessonsPage flags', () => {
  it('lets managers quarantine with a required reason', async () => {
    const fetchSpy = mock([lesson()], ['r1']);
    render(withQuery(<LessonsPage />));
    fireEvent.click(await screen.findByRole('button', { name: 'Quarantine' }));
    const submit = await screen.findByRole('button', { name: 'Quarantine lesson' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.change(await screen.findByLabelText('What is wrong with it'), {
      target: { value: '  Old migration advice  ' },
    });
    fireEvent.click(submit);
    await vi.waitFor(() =>
      expect(bodyOf(fetchSpy, '/api/v1/lessons/l1/quarantine')).toEqual({
        reason: 'Old migration advice',
      })
    );
  });

  it('labels quarantine and lets managers restore with a clear-flags confirmation', async () => {
    const fetchSpy = mock(
      [
        lesson({
          quarantinedAt: '2026-10-01T00:00:00Z',
          quarantineReason: '2 distinct flags',
          quarantineSource: 'FLAG_THRESHOLD',
        }),
      ],
      ['r1']
    );
    render(withQuery(<LessonsPage />));
    expect(await screen.findByText('Quarantined')).toBeTruthy();
    expect(screen.getByText(/Flag threshold/)).toBeTruthy();
    expect(screen.getByText(/2 distinct flags/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restore lesson' });
    expect(within(dialog).getByText(/clear all its flags/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await vi.waitFor(() => expect(bodyOf(fetchSpy, '/api/v1/lessons/l1/restore')).toEqual({}));
  });

  it('shows quarantine to readers without offering management controls', async () => {
    useAuthStore.setState({ user: { role: 'ENGINEER', sub: 'me' } });
    mock([
      lesson({
        quarantinedAt: '2026-10-01T00:00:00Z',
        quarantineReason: 'Retired API',
        quarantineSource: 'MANUAL',
      }),
    ]);
    render(withQuery(<LessonsPage />));
    expect(await screen.findByText('Quarantined')).toBeTruthy();
    expect(screen.getByText(/Retired API/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Quarantine' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Flag' })).toBeTruthy();
  });

  it('sends the quarantine filter and clears it', async () => {
    const fetchSpy = mock([lesson()]);
    render(withQuery(<LessonsPage />));
    fireEvent.click(await screen.findByRole('button', { name: /quarantine filter/i }));
    fireEvent.click(await screen.findByRole('option', { name: 'Quarantined only' }));
    await vi.waitFor(() =>
      expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('quarantined=true'))).toBe(
        true
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  it('shows a quarantine failure without dismissing the reason', async () => {
    mock([lesson()], ['r1']);
    const fetchSpy = vi.mocked(fetch);
    const baseFetch = fetchSpy.getMockImplementation();
    if (!baseFetch) {
      throw new Error('Missing fetch mock');
    }
    fetchSpy.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/quarantine')) {
        throw new Error('quarantine unavailable');
      }
      return baseFetch(url, init);
    });
    render(withQuery(<LessonsPage />));
    fireEvent.click(await screen.findByRole('button', { name: 'Quarantine' }));
    fireEvent.change(await screen.findByLabelText('What is wrong with it'), {
      target: { value: 'stale' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Quarantine lesson' }));
    expect(await screen.findByText('quarantine unavailable')).toBeTruthy();
    expect((screen.getByLabelText('What is wrong with it') as HTMLTextAreaElement).value).toBe(
      'stale'
    );
  });
  beforeEach(() => {
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'ENGINEER', sub: 'me' } });
  });

  it('lets a reader flag a lesson with a reason', async () => {
    const fetchSpy = mock([lesson({ flagCount: 0, myFlag: null })]);
    render(withQuery(<LessonsPage />));
    await screen.findByText('Run migrations before deploying');
    fireEvent.click(screen.getByRole('button', { name: 'Flag' }));
    fireEvent.change(await screen.findByLabelText('What is wrong with it'), {
      target: { value: 'The deploy script runs them now' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Flag lesson' }));
    await vi.waitFor(() =>
      expect(bodyOf(fetchSpy, '/api/v1/lessons/l1/flags')).toEqual({
        reason: 'The deploy script runs them now',
      })
    );
  });

  it("shows a reader their own flag as one they can withdraw, without anyone else's reasons", async () => {
    mock([
      lesson({
        flagCount: 2,
        myFlag: { createdAt: '2026-10-01T00:00:00.000Z', reason: 'outdated' },
      }),
    ]);
    render(withQuery(<LessonsPage />));
    expect(await screen.findByText('Flagged · 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Withdraw flag' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear flags' })).toBeNull();
  });

  it('shows a lead the reasons and lets them clear the flags', async () => {
    const fetchSpy = mock(
      [
        lesson({
          flagCount: 1,
          flags: [{ createdAt: '2026-10-01T00:00:00.000Z', email: 'a@x.test', reason: 'stale' }],
          myFlag: null,
        }),
      ],
      ['r1']
    );
    render(withQuery(<LessonsPage />));
    expect(await screen.findByText('stale')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear flags' }));
    const confirm = await screen.findAllByRole('button', { name: 'Clear flags' });
    fireEvent.click(confirm[confirm.length - 1] as HTMLElement);
    await vi.waitFor(() =>
      expect(
        fetchSpy.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/api/v1/lessons/l1/flags') &&
            (init as RequestInit | undefined)?.method === 'DELETE'
        )
      ).toBe(true)
    );
  });

  it('tells a reader when withdrawing their flag fails', async () => {
    setupFetchMock({
      '/api/v1/admin/config/consolidation': () => ({ data: null }),
      'DELETE /api/v1/lessons/l1/flags/mine': () => {
        throw new Error('flag service down');
      },
      'GET /api/v1/lessons': () => ({
        data: [
          lesson({
            flagCount: 1,
            myFlag: { createdAt: '2026-10-01T00:00:00.000Z', reason: 'outdated' },
          }),
        ],
        meta: { limit: 20, offset: 0, total: 1 },
      }),
      'GET /api/v1/lessons/stats': () => ({ data: [] }),
      'GET /api/v1/repositories': () => ({ data: [], meta: { limit: 100, offset: 0, total: 0 } }),
    });
    render(withQuery(<LessonsPage />));
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw flag' }));
    expect((await screen.findByRole('alert')).textContent).toContain('flag service down');
  });

  it('offers Clear filters while a filter is on, not only on an empty result', async () => {
    mock([lesson()]);
    render(withQuery(<LessonsPage />));
    await screen.findByText('Run migrations before deploying');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /flag filter/i }));
    fireEvent.click(await screen.findByRole('option', { name: 'Flagged only' }));
    expect(await screen.findByRole('button', { name: 'Clear filters' })).toBeTruthy();
  });

  it('asks the server for flagged lessons only when filtered to them', async () => {
    const fetchSpy = mock([lesson()]);
    render(withQuery(<LessonsPage />));
    await screen.findByText('Run migrations before deploying');
    fireEvent.click(screen.getByRole('button', { name: /flag filter/i }));
    fireEvent.click(await screen.findByRole('option', { name: 'Flagged only' }));
    await vi.waitFor(() =>
      expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('flagged=true'))).toBe(true)
    );
  });
});
