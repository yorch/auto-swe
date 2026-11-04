// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import GovernConfigGrantsPage from './page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

beforeEach(() => {
  stubDialogPrototype();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mock() {
  return setupFetchMock({
    'GET /api/v1/platform/config/grants': () => ({ data: [] }),
    'GET /api/v1/platform/config/grants/preview': () => ({
      data: { keyPattern: '*', keys: ['a.b', 'c.d'], requiredRole: 'ADMIN', settings: [] },
    }),
    'GET /api/v1/platform/organizations/budget-alerts': () => ({ data: [] }),
    'GET /api/v1/teams': () => ({ data: [] }),
    'GET /api/v1/users': () => ({ data: [] }),
    'POST /api/v1/platform/config/grants': () => ({ data: { id: 'g1' } }),
  });
}

describe('config grants: broad grants', () => {
  it('asks for confirmation before creating a grant for every setting, and creates only after it', async () => {
    const spy = mock();
    render(withQuery(<GovernConfigGrantsPage />));
    fireEvent.change(await screen.findByLabelText(/Key pattern/), { target: { value: '*' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create grant' }));
    expect(await screen.findByText('Create a broad grant?')).toBeTruthy();
    expect(spy.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'POST')).toBe(false);

    fireEvent.click(screen.getAllByRole('button', { name: 'Create grant' }).at(-1) as HTMLElement);
    await waitFor(() =>
      expect(bodyOf(spy, '/api/v1/platform/config/grants')).toMatchObject({
        keyPattern: '*',
        role: 'LEAD',
        scope: 'GLOBAL',
      })
    );
  });

  it('labels the example chips as an action rather than a toggle', async () => {
    mock();
    render(withQuery(<GovernConfigGrantsPage />));
    const chip = await screen.findByRole('button', { name: 'Use pattern channel.*' });
    expect(chip.getAttribute('aria-pressed')).toBeNull();
  });
});
