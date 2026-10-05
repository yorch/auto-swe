// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { nav, resetNavigation } from '@/test/mockNavigation';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

import GovernOrganizationsPage from './page';

beforeEach(() => {
  resetNavigation('', '/govern/organizations');
  useAuthStore.setState({ user: { role: 'ADMIN' } } as never);
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
      '/api/v1/platform/organizations/budget-alerts': () => ({
        data: [org('a', true), org('b', false)],
      }),
    });
    render(withQuery(<GovernOrganizationsPage />));
    await screen.findByText('Org b');
    expect(spy.mock.calls.some(([u]) => String(u).endsWith('/organizations'))).toBe(false);
    fireEvent.click(screen.getByLabelText('Alerting only'));
    expect(nav.replace.at(-1)).toBe('/govern/organizations?alerting=1');
  });
});
