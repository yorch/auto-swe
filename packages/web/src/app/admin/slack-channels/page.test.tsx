// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import GovernSlackChannelsPage from './page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const channel = (over: Record<string, unknown>) => ({
  currentMonthUsage: { costUsdAccrued: 1 },
  id: 'c',
  isActive: true,
  isPrivate: false,
  monthlyBudgetUsdCents: null,
  name: 'general',
  slackChannelId: 'C0',
  teamId: 't1',
  ...over,
});

beforeEach(() => {
  stubDialogPrototype();
  setupFetchMock({
    '/api/v1/platform/slack-channels': () => ({
      data: [
        channel({ currentMonthUsage: { costUsdAccrued: 5 }, id: 'c1', name: 'zeta' }),
        channel({
          currentMonthUsage: { costUsdAccrued: 9 },
          id: 'c2',
          isPrivate: true,
          name: 'alpha',
        }),
      ],
    }),
    '/api/v1/teams': () => ({ data: [{ id: 't1', name: 'Payments' }] }),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const order = () => screen.getAllByRole('link').map((a) => a.textContent);

describe('GovernSlackChannelsPage', () => {
  it('opens each channel from its name and sorts by name and spend', async () => {
    render(withQuery(<GovernSlackChannelsPage />));
    const zeta = await screen.findByRole('link', { name: '#zeta' });
    expect(zeta.getAttribute('href')).toBe('/admin/slack-channels/c1');
    expect(order()).toEqual(['#zeta', '#alpha']);

    fireEvent.click(screen.getByRole('button', { name: 'Channel' }));
    expect(order()).toEqual(['#alpha', '#zeta']);

    fireEvent.click(screen.getByRole('button', { name: 'Spend this month' }));
    expect(order()).toEqual(['#zeta', '#alpha']);
    fireEvent.click(screen.getByRole('button', { name: 'Spend this month' }));
    expect(order()).toEqual(['#alpha', '#zeta']);
  });
});
