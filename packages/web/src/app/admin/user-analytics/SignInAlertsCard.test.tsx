// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SignInAlerts } from '@/hooks/useAdmin';
import { gatewayError, setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { SignInAlertsCard } from './SignInAlertsCard';

afterEach(() => vi.unstubAllGlobals());

const base: SignInAlerts = {
  alerts: [],
  generatedAt: '2026-10-01T12:00:00.000Z',
  threshold: 5,
  truncated: false,
  windowMinutes: 15,
};

describe('SignInAlertsCard', () => {
  it('shows a calm empty state', async () => {
    setupFetchMock({ 'GET /api/v1/platform/analytics/alerts': () => base });
    render(withQuery(<SignInAlertsCard />));
    expect(
      await screen.findByText(/No accounts over threshold in the last 15 minutes/)
    ).toBeTruthy();
  });

  it('says plainly when the threshold can never be reached', async () => {
    setupFetchMock({
      'GET /api/v1/platform/analytics/alerts': () => ({
        ...base,
        failuresRecordedPerMinute: 30,
        maxRecordable: 480,
        threshold: 100,
        thresholdReachable: false,
        windowMinutes: 1,
      }),
    });
    render(withQuery(<SignInAlertsCard />));
    expect(await screen.findByText(/no alert can fire/)).toBeTruthy();
    expect(screen.getByText(/At most 30 failed sign-ins per account are recorded/)).toBeTruthy();
  });

  it('lists accounts with a link to the person and the signed-in-afterwards flag', async () => {
    setupFetchMock({
      'GET /api/v1/platform/analytics/alerts': () => ({
        ...base,
        alerts: [
          {
            email: 'a@x.io',
            failures: 7,
            firstAt: '2026-10-01T11:50:00.000Z',
            lastAt: '2026-10-01T11:59:00.000Z',
            methods: ['password'],
            name: 'Ada',
            signedInAfter: true,
            userId: 'u1',
          },
        ],
      }),
    });
    render(withQuery(<SignInAlertsCard />));
    const link = await screen.findByText('Ada (a@x.io)');
    expect(link.closest('a')?.getAttribute('href')).toBe('/admin/user-analytics/users/u1');
    expect(screen.getByText('7 failed')).toBeTruthy();
    expect(screen.getByText('Signed in afterwards')).toBeTruthy();
  });

  it('shows an error as unknown, not as zero', async () => {
    setupFetchMock({
      'GET /api/v1/platform/analytics/alerts': () => gatewayError(500, 'BOOM'),
    });
    render(withQuery(<SignInAlertsCard />));
    expect(await screen.findByText(/unknown — not zero/)).toBeTruthy();
    expect(screen.queryByText(/No accounts over threshold/)).toBeNull();
  });
});
