// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import GovernSessionsPage from './page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const session = (id: string, email: string, current: boolean) => ({
  createdAt: '2026-10-01T00:00:00.000Z',
  current,
  expiresAt: '2026-12-01T00:00:00.000Z',
  id,
  ipAddress: null,
  token: `tok-${id}-0000`,
  updatedAt: '2026-10-02T00:00:00.000Z',
  user: { email, id: `u-${id}` },
  userAgent: null,
});

beforeEach(() => {
  stubDialogPrototype();
  setupFetchMock({
    '/api/v1/platform/sessions': () => ({
      data: [session('s1', 'me@x.com', true), session('s2', 'b@x.com', false)],
    }),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GovernSessionsPage', () => {
  it('warns that revoking your own session signs you out', async () => {
    render(withQuery(<GovernSessionsPage />));
    fireEvent.click(await screen.findByRole('button', { name: "Actions for me@x.com's session" }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke (signs you out)' }));
    expect(await screen.findByText(/This is your own session/)).toBeTruthy();
  });

  it('sorts by user when the heading is clicked', async () => {
    render(withQuery(<GovernSessionsPage />));
    fireEvent.click(await screen.findByRole('button', { name: 'User and device' }));
    const first = screen.getAllByRole('row')[1];
    expect(first?.textContent).toContain('b@x.com');
  });
});
