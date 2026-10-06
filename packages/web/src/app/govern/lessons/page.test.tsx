// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import GovernLessonsPage from './page';

const lesson = (over: Record<string, unknown> = {}) => ({
  consolidatedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  failureType: 'CI_FAILURE',
  id: 'l1',
  lessonSummary: 'Run migrations before deploying',
  rationale: null,
  repository: { id: 'r1', organizationName: 'acme', repoName: 'api' },
  workflow: null,
  ...over,
});

function mock(rows: unknown[]) {
  return setupFetchMock({
    '/api/v1/admin/config/consolidation': () => ({ data: null }),
    'GET /api/v1/lessons': () => ({
      data: rows,
      meta: { limit: 20, offset: 0, total: rows.length },
    }),
    'GET /api/v1/lessons/stats': () => ({ data: [] }),
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

describe('GovernLessonsPage', () => {
  it('lists a lesson whose repository has been deleted instead of crashing', async () => {
    mock([lesson(), lesson({ id: 'l2', lessonSummary: 'Pin the base image', repository: null })]);
    render(withQuery(<GovernLessonsPage />));
    expect(await screen.findByText('Pin the base image')).toBeTruthy();
    expect(screen.getByText('Deleted repository')).toBeTruthy();
    expect(screen.getByText('acme/api')).toBeTruthy();
  });
});
