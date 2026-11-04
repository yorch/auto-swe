// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import UsersPage from './page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const user = (id: string, email: string, role: string, isActive: boolean) => ({
  createdAt: '2026-01-01T00:00:00.000Z',
  email,
  id,
  isActive,
  memberships: [],
  role,
  slackId: null,
});

beforeEach(() => {
  stubDialogPrototype();
  useAuthStore.setState({ isAuthenticated: true, user: { role: 'ADMIN', sub: 'me' } } as never);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mock() {
  return setupFetchMock({
    'GET /api/v1/users': () => ({
      data: [
        user('me', 'me@x.com', 'ADMIN', true),
        user('u2', 'eng@x.com', 'ENGINEER', true),
        user('u3', 'waiting@x.com', 'ENGINEER', false),
      ],
    }),
    'PATCH /api/v1/users/u2': () => ({ data: {} }),
    'POST /api/v1/users/invite': () => ({ data: {} }),
  });
}

describe('UsersPage', () => {
  it('does not call every inactive account a sign-up: the list says suspended members land there too', async () => {
    mock();
    render(withQuery(<UsersPage />));
    expect(await screen.findByText('Awaiting approval')).toBeTruthy();
    expect(screen.getByText(/members you suspend move here too/)).toBeTruthy();
  });

  it('confirms a promotion to admin before the role is saved', async () => {
    const spy = mock();
    render(withQuery(<UsersPage />));
    fireEvent.click(await screen.findByRole('button', { name: /Role for eng@x.com/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Admin' }));
    expect(await screen.findByText('Change role?')).toBeTruthy();
    expect(spy.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'PATCH')).toBe(
      false
    );
    fireEvent.click(screen.getByRole('button', { name: 'Make admin' }));
    await waitFor(() =>
      expect(bodyOf(spy, '/api/v1/users/u2', 'PATCH')).toEqual({ role: 'ADMIN' })
    );
  });

  it('invites from a dialog and confirms it with a notice that goes away on its own', async () => {
    const spy = mock();
    render(withQuery(<UsersPage />));
    fireEvent.click(await screen.findByRole('button', { name: 'Invite user' }));
    fireEvent.change(document.querySelector('[name="invite-email"]') as HTMLInputElement, {
      target: { value: 'new@x.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    await waitFor(() =>
      expect(bodyOf(spy, '/api/v1/users/invite')).toEqual({ email: 'new@x.com', role: 'ENGINEER' })
    );
    expect(await screen.findByText(/Invite sent to new@x.com/)).toBeTruthy();
  });
});
