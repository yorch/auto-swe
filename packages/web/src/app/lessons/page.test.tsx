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
  id: 'l1',
  lessonSummary: 'Run migrations before deploying',
  metadata: null,
  rationale: null,
  repository: { id: 'r1', organizationName: 'acme', repoName: 'api' },
  workflow: null,
  workflowRunId: null,
  ...over,
});

function mock(rows: unknown[], managedRepoIds?: string[]) {
  return setupFetchMock({
    '/api/v1/admin/config/consolidation': () => ({ data: null }),
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
    // The listbox is closed; its hidden native select carries the same options.
    expect(await screen.findByRole('option', { hidden: true, name: 'acme/api' })).toBeTruthy();
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

    fireEvent.click(screen.getByRole('button', { name: /repository/i }));
    fireEvent.click(await screen.findByRole('option', { name: 'acme/api' }));
    fireEvent.click(await screen.findByRole('button', { name: /consolidate this repository/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run consolidation' }));

    expect(await screen.findByText(/Consolidation started for acme\/api/)).toBeTruthy();
    expect(bodyOf(fetchSpy, '/api/v1/lessons/consolidate')).toEqual({ repoId: 'r1' });
  });
});
