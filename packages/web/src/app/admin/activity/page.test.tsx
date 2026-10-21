// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetNavigation } from '@/test/mockNavigation';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

import UserActivityPage from './page';

beforeEach(() => resetNavigation('', '/admin/activity'));
afterEach(() => vi.unstubAllGlobals());

describe('UserActivityPage', () => {
  it('shows totals, top denied routes, recent events and the drop counter', async () => {
    const spy = setupFetchMock({
      'GET /api/v1/platform/activity': () => ({
        data: [
          {
            actor: { email: 'alice@example.com', name: 'Alice' },
            actorId: '11111111-1111-4111-8111-111111111111',
            createdAt: '2026-10-01T10:00:00.000Z',
            id: 'e1',
            ip: '198.51.100.0',
            kind: 'denied',
            method: 'GET',
            requestId: 'r1',
            route: '/api/v1/platform/audit-log',
            status: 403,
            via: 'jwt',
          },
        ],
        meta: { limit: 50, offset: 0, total: 1 },
      }),
      'GET /api/v1/platform/activity/summary': () => ({
        daily: [{ day: '2026-10-01', denied: 3, export: 0, read: 1, ui: 0 }],
        days: 14,
        dropped: 7,
        retentionDays: 90,
        topDenied: [{ count: 3, route: '/api/v1/platform/audit-log' }],
        totals: { denied: 3, export: 0, read: 1, ui: 0 },
        uiEventsEnabled: false,
      }),
    });
    render(withQuery(<UserActivityPage />));

    await screen.findByText('alice@example.com');
    expect(screen.getByText('Top denied routes')).toBeTruthy();
    expect(screen.getAllByText('/api/v1/platform/audit-log').length).toBeGreaterThan(0);
    expect(screen.getByText(/Page views are off/)).toBeTruthy();
    expect(screen.getByText(/dropped 7 events/)).toBeTruthy();
    expect(
      spy.mock.calls.map(([u]) => String(u)).some((u) => u.includes('/activity/summary'))
    ).toBe(true);
  });
});
