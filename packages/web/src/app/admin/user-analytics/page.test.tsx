// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsOverview, AnalyticsUsersPage } from '@/hooks/useAdmin';
import { nav, resetNavigation } from '@/test/mockNavigation';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

import UserAnalyticsPage from './page';

const UID = '11111111-1111-4111-8111-111111111111';

function overview(over: Partial<AnalyticsOverview> = {}): AnalyticsOverview {
  return {
    actions: {
      byAction: { CREATE: 2, DELETE: 0, UPDATE: 3 },
      byEntityType: [{ count: 5, entityType: 'Repository' }],
      total: 5,
    },
    activeByDay: [
      { actions: 5, activeUsers: 2, day: '2026-10-01', failedSignIns: 1, signIns: 3, signOuts: 1 },
    ],
    activeSessions: 4,
    days: 14,
    generatedAt: '2026-10-01T12:00:00.000Z',
    peakHours: Array.from({ length: 24 }, (_, h) => (h === 9 ? 6 : 0)),
    recentFailures: [
      {
        createdAt: '2026-10-01T10:00:00.000Z',
        email: 'alice@example.com',
        id: 'f1',
        ip: '198.51.100.0',
        method: 'password',
        reason: 'invalid_credentials',
        userId: UID,
      },
    ],
    signIns: {
      byBrowser: [{ count: 3, name: 'Chrome' }],
      byMethod: [{ count: 3, method: 'github' }],
      byOs: [{ count: 3, name: 'macOS' }],
      failed: 1,
      total: 3,
    },
    topUsers: [
      {
        actions: 5,
        email: 'alice@example.com',
        lastActiveAt: '2026-10-01T10:00:00.000Z',
        name: 'Alice',
        signIns: 3,
        userId: UID,
      },
    ],
    truncated: false,
    users: {
      dau: 2,
      mau: 8,
      neverSignedIn: 1,
      newInWindow: 2,
      stickinessPct: 25,
      total: 9,
      wau: 5,
    },
    ...over,
  };
}

const USERS: AnalyticsUsersPage = {
  data: [
    {
      actions: 5,
      activeDays: 3,
      activeSessions: 1,
      createdAt: '2026-09-01T00:00:00.000Z',
      email: 'alice@example.com',
      failedSignIns: 1,
      lastActiveAt: '2026-10-01T10:00:00.000Z',
      lastSignInAt: '2026-10-01T09:00:00.000Z',
      name: 'Alice',
      role: 'ADMIN',
      signIns: 3,
      userId: UID,
    },
  ],
  meta: { days: 14, limit: 25, offset: 0, total: 1, truncated: false },
};

beforeEach(() => resetNavigation('', '/admin/user-analytics'));
afterEach(() => vi.unstubAllGlobals());

describe('UserAnalyticsPage', () => {
  it('shows the tiles, breakdowns, failures and a people table linking to each person', async () => {
    const spy = setupFetchMock({
      'GET /api/v1/platform/analytics/overview': () => overview(),
      'GET /api/v1/platform/analytics/users': () => USERS,
    });
    render(withQuery(<UserAnalyticsPage />));

    expect(await screen.findByText('Daily active')).toBeTruthy();
    expect(await screen.findByText('25%')).toBeTruthy();
    expect(screen.getAllByText('Failed sign-ins').length).toBeGreaterThan(0);
    expect(screen.getByText('Recent failed sign-ins')).toBeTruthy();
    expect(screen.getByText('Invalid credentials')).toBeTruthy();
    expect(screen.getByLabelText('Sign-ins by method').textContent).toContain('GitHub');
    expect(screen.getByLabelText('Sign-ins by browser').textContent).toContain('Chrome');
    expect(screen.getByLabelText('Actions by entity type').textContent).toContain('Repository');

    const links = (await screen.findAllByRole('link', { name: /Alice/ })) as HTMLAnchorElement[];
    expect(
      links.every((l) => l.getAttribute('href') === `/admin/user-analytics/users/${UID}`)
    ).toBe(true);
    const urls = spy.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes('/analytics/overview?days=14'))).toBe(true);
    expect(urls.some((u) => u.includes('/analytics/users?') && u.includes('sort=lastActive'))).toBe(
      true
    );
  });

  it('shows an error, not zeros, when the overview cannot be loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const failing = String(input).includes('/analytics/overview');
        return new Response(JSON.stringify(failing ? { error: { message: 'boom' } } : USERS), {
          headers: { 'content-type': 'application/json' },
          status: failing ? 500 : 200,
        });
      })
    );
    render(withQuery(<UserAnalyticsPage />));
    expect(
      await screen.findByText(/overview could not be loaded, so the figures below are unknown/)
    ).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('syncs the window and sort to the URL', async () => {
    setupFetchMock({
      'GET /api/v1/platform/analytics/overview': () => overview(),
      'GET /api/v1/platform/analytics/users': () => USERS,
    });
    render(withQuery(<UserAnalyticsPage />));
    await screen.findByText('Daily active');
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    expect(nav.replace.at(-1)).toContain('days=30');
    fireEvent.click(await screen.findByRole('button', { name: /Actions/ }));
    expect(nav.replace.at(-1)).toContain('sort=actions');
  });

  it('shows empty states when nothing was recorded', async () => {
    setupFetchMock({
      'GET /api/v1/platform/analytics/overview': () =>
        overview({
          recentFailures: [],
          signIns: { byBrowser: [], byMethod: [], byOs: [], failed: 0, total: 0 },
        }),
      'GET /api/v1/platform/analytics/users': () => ({ ...USERS, data: [] }),
    });
    render(withQuery(<UserAnalyticsPage />));
    expect(await screen.findByText('No failed sign-ins recorded')).toBeTruthy();
    expect(
      screen.getByText(
        'No one matches that search'.replace('No one matches that search', 'No people found')
      )
    ).toBeTruthy();
  });
});
