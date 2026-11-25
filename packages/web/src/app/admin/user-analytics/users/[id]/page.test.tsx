// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetNavigation } from '@/test/mockNavigation';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));

import UserAnalyticsDetailPage from './page';

function resolvedParams<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), { status: 'fulfilled', value });
}

const UID = '11111111-1111-4111-8111-111111111111';

const DETAIL = {
  actionsByAction: { CREATE: 1, DELETE: 0, UPDATE: 2 },
  actionsByEntityType: [{ count: 3, entityType: 'Repository' }],
  daily: [{ actions: 3, day: '2026-10-01', failedSignIns: 1, signIns: 2 }],
  recentActions: [
    {
      action: 'UPDATE',
      createdAt: '2026-10-01T10:00:00.000Z',
      entityId: 'abcdef12-0000',
      entityType: 'Repository',
      id: 'a1',
      via: 'jwt',
    },
  ],
  sessions: [
    {
      browser: 'Chrome',
      createdAt: '2026-10-01T09:00:00.000Z',
      expiresAt: '2026-10-08T09:00:00.000Z',
      id: 's1',
      ipTruncated: '198.51.100.0',
      os: 'macOS',
    },
  ],
  signInHistory: [
    {
      browser: 'Chrome',
      createdAt: '2026-10-01T09:00:00.000Z',
      id: 'h1',
      ip: '198.51.100.0',
      kind: 'sign_in',
      method: 'github',
      os: 'macOS',
      reason: null,
    },
    {
      browser: 'Firefox',
      createdAt: '2026-10-01T08:00:00.000Z',
      id: 'h2',
      ip: null,
      kind: 'sign_in_failed',
      method: 'password',
      os: 'Linux',
      reason: 'invalid_credentials',
    },
  ],
  summary: {
    actions: 3,
    activeDays: 2,
    failedSignIns: 1,
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    lastActiveAt: '2026-10-01T10:00:00.000Z',
    lastSignInAt: '2026-10-01T09:00:00.000Z',
    signIns: 2,
    signOuts: 1,
  },
  topPages: [],
  user: {
    createdAt: '2026-09-01T00:00:00.000Z',
    email: 'alice@example.com',
    id: UID,
    name: 'Alice',
    role: 'ADMIN',
    teams: [{ id: 't1', role: 'LEAD', slug: 'payments' }],
  },
};

beforeEach(() => resetNavigation('', `/admin/user-analytics/users/${UID}`));
afterEach(() => vi.unstubAllGlobals());

describe('UserAnalyticsDetailPage', () => {
  it('shows the profile, history, actions, sessions and the opt-in page-view note', async () => {
    const spy = setupFetchMock({
      [`GET /api/v1/platform/analytics/users/${UID}`]: () => DETAIL,
    });
    render(withQuery(<UserAnalyticsDetailPage params={resolvedParams({ id: UID })} />));

    expect(await screen.findByRole('heading', { name: 'Alice' })).toBeTruthy();
    expect(screen.getByText(/payments \(Team lead\)/)).toBeTruthy();
    expect(screen.getByText(/alice@example.com · Platform admin/)).toBeTruthy();
    expect(screen.getByText('Signed in')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getAllByText('Invalid credentials').length).toBeGreaterThan(0);
    expect(screen.getByText('Recent actions')).toBeTruthy();
    expect(screen.getByText('abcdef12')).toBeTruthy();
    expect(screen.getByText('Active sessions')).toBeTruthy();
    expect(screen.getByText('No page views recorded')).toBeTruthy();
    expect(screen.getByText(/Page views are opt-in/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /User analytics/ }).getAttribute('href')).toBe(
      '/admin/user-analytics'
    );
    expect(String(spy.mock.calls[0]?.[0])).toContain('days=14');
  });

  it('says so when the person does not exist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'nope' } }), {
            headers: { 'content-type': 'application/json' },
            status: 404,
          })
      )
    );
    render(withQuery(<UserAnalyticsDetailPage params={resolvedParams({ id: UID })} />));
    expect(await screen.findByText('Person not found')).toBeTruthy();
  });
});
