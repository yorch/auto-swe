// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { nav, resetNavigation } from '@/test/mockNavigation';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

import GovernOrganizationsPage from './page';

beforeEach(() => {
  resetNavigation('', '/admin/organizations');
  useAuthStore.setState({ user: { role: 'USER', sub: 'me' } } as never);
});
afterEach(() => vi.unstubAllGlobals());

const org = (id: string, triggered: boolean) => ({
  alert: { percent: triggered ? 95 : 10, triggered },
  budgetAlertThresholdPercent: 80,
  currentMonthUsage: null,
  id,
  monthlyBudgetUsdCents: 1000,
  name: `Org ${id}`,
  slug: id,
});

describe('GovernOrganizationsPage', () => {
  it('lists every organization for an admin and filters to alerting ones through the URL', async () => {
    const spy = setupFetchMock({
      // The server says this person holds a platform capability only a platform admin holds.
      '/api/v1/me/permissions': () => ({
        organizations: [],
        platformCapabilities: ['platform.users.manage'],
        platformRole: '',
        teams: [],
      }),
      '/api/v1/platform/organizations/budget-alerts': () => ({
        data: [org('a', true), org('b', false)],
      }),
    });
    render(withQuery(<GovernOrganizationsPage />));
    await screen.findByText('Org b');
    expect(spy.mock.calls.some(([u]) => String(u).endsWith('/organizations'))).toBe(false);
    fireEvent.click(screen.getByLabelText('Alerting only'));
    expect(nav.replace.at(-1)).toBe('/admin/organizations?alerting=1');
  });

  it('asks for deactivated organizations too, marks them, and does not count their alerts', async () => {
    const spy = setupFetchMock({
      '/api/v1/me/permissions': () => ({
        organizations: [],
        platformCapabilities: ['platform.users.manage'],
        platformRole: '',
        teams: [],
      }),
      '/api/v1/platform/organizations/budget-alerts': () => ({
        data: [org('a', false), { ...org('gone', true), isActive: false }],
      }),
    });
    render(withQuery(<GovernOrganizationsPage />));
    await screen.findByText('Org gone');
    expect(screen.getByText('Inactive')).toBeTruthy();
    expect(
      spy.mock.calls.some(([u]) => String(u).endsWith('/budget-alerts?includeInactive=true'))
    ).toBe(true);
    // The only organization over its threshold is inactive, so no alert banner.
    expect(screen.queryByText(/above the monthly budget alert threshold/)).toBeNull();
  });
});
