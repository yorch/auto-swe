// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { AddMemberModal } from './AddMemberModal';

function signInAs(role: 'ADMIN' | 'LEAD') {
  useAuthStore.setState({ isAuthenticated: true, user: { role, sub: 'me' } });
}

beforeEach(() => {
  stubDialogPrototype();
  signInAs('ADMIN');
});
afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ isAuthenticated: false, user: null });
});

const TEAM_ID = 't1';
const USERS = [
  { email: 'eligible@example.com', id: 'u1', isActive: true, role: 'ENGINEER', slackId: null },
  { email: 'already-member@example.com', id: 'u2', isActive: true, role: 'LEAD', slackId: null },
  { email: 'inactive@example.com', id: 'u3', isActive: false, role: 'ENGINEER', slackId: null },
];

describe('AddMemberModal', () => {
  it('POSTs the chosen user + role and excludes already-members from the dropdown', async () => {
    const onClose = vi.fn();
    const spy = setupFetchMock({
      '/api/v1/users': () => ({ data: USERS }),
      [`/api/v1/teams/${TEAM_ID}/members`]: () => ({ data: { ok: true } }),
    });

    render(
      withQuery(
        <AddMemberModal existingUserIds={['u2']} onClose={onClose} open={true} teamId={TEAM_ID} />
      )
    );

    const userInput = (await screen.findByRole('combobox', { name: /user/i })) as HTMLInputElement;
    // Nothing is preselected: submit stays disabled until an explicit pick.
    expect(userInput.value).toBe('');
    expect(
      (screen.getByRole('button', { name: /add member/i }) as HTMLButtonElement).disabled
    ).toBe(true);
    // Filter excludes the existing member u2 AND the inactive u3
    act(() => userInput.focus());
    fireEvent.change(userInput, { target: { value: '@example.com' } });
    const values = screen.getAllByRole('option').map((o) => o.textContent);
    expect(values).toHaveLength(1);
    expect(values[0]).toContain('eligible@example.com');
    // Picking it closes the list (an open popover makes the rest of the dialog inert).
    fireEvent.click(screen.getByRole('option'));

    // Bump role to LEAD before submitting. The select has id="role" so the
    // accessible name resolves to "Team role" — match exactly to avoid the
    // /role/i regex also catching the "Role" column in any other render.
    fireEvent.click(screen.getByRole('button', { name: /team role/i }));
    fireEvent.click(screen.getByRole('option', { name: 'LEAD' }));
    fireEvent.click(screen.getByRole('button', { name: /add member/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(bodyOf(spy, `/api/v1/teams/${TEAM_ID}/members`, 'POST')).toEqual({
      role: 'LEAD',
      userId: 'u1',
    });
  });

  it('disables submit + shows guidance when no users are eligible', async () => {
    const onClose = vi.fn();
    setupFetchMock({
      '/api/v1/users': () => ({ data: [USERS[1]] }), // only u2, who is already a member
    });

    render(
      withQuery(
        <AddMemberModal existingUserIds={['u2']} onClose={onClose} open={true} teamId={TEAM_ID} />
      )
    );

    await waitFor(() => {
      expect(screen.getByText(/no active users left to add/i)).toBeTruthy();
    });
    const submit = screen.getByRole('button', { name: /add member/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('lets a LEAD, who cannot list users, add one by exact email', async () => {
    signInAs('LEAD');
    const onClose = vi.fn();
    const spy = setupFetchMock({
      '/api/v1/users/lookup': () => ({
        data: { email: 'eligible@example.com', id: 'u1', name: 'Eli' },
      }),
      [`/api/v1/teams/${TEAM_ID}/members`]: () => ({ data: { ok: true } }),
    });

    render(
      withQuery(
        <AddMemberModal existingUserIds={['u2']} onClose={onClose} open={true} teamId={TEAM_ID} />
      )
    );

    const submit = screen.getByRole('button', { name: /add member/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/user/i), {
      target: { value: 'eligible@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /find/i }));
    await waitFor(() => expect(screen.getByText(/eligible@example.com · Eli/)).toBeTruthy());

    fireEvent.click(submit);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(bodyOf(spy, `/api/v1/teams/${TEAM_ID}/members`, 'POST')).toEqual({
      role: 'ENGINEER',
      userId: 'u1',
    });
    // The ADMIN-only directory was never requested.
    expect(spy.mock.calls.some(([u]) => String(u).endsWith('/api/v1/users'))).toBe(false);
  });
});
