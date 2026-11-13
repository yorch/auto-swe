// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '@/lib/api';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { InviteTeamMemberModal } from './InviteTeamMemberModal';

beforeEach(stubDialogPrototype);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('team invitation form', () => {
  it.each([true, false])('reports the response approval state isActive=%s', async (isActive) => {
    const onInvited = vi.fn();
    const onClose = vi.fn();
    const spy = setupFetchMock({
      '/api/v1/teams/t1/members/invite': () => ({
        data: { email: 'new@acme.com', id: 'u1', isActive },
      }),
    });
    render(
      withQuery(
        <InviteTeamMemberModal
          grantableRoles={['ENGINEER', 'LEAD']}
          onClose={onClose}
          onInvited={onInvited}
          open
          teamId="t1"
        />
      )
    );
    expect(
      (screen.getByRole('button', { name: 'Send invite' }) as HTMLButtonElement).disabled
    ).toBe(true);
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'new@acme.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Team role/ }));
    expect(screen.queryByRole('option', { name: 'Admin' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Lead' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(bodyOf(spy, '/teams/t1/members/invite')).toEqual({
      email: 'new@acme.com',
      role: 'LEAD',
    });
    expect(onInvited).toHaveBeenCalledWith(
      expect.stringContaining(isActive ? 'active and approved' : 'waiting for platform approval')
    );
  });

  it('keeps duplicate-email errors in the form with add-member guidance', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError('User exists', 409, 'USER_EXISTS'));
    const onClose = vi.fn();
    render(
      withQuery(
        <InviteTeamMemberModal
          grantableRoles={['ENGINEER']}
          onClose={onClose}
          onInvited={vi.fn()}
          open
          teamId="t1"
        />
      )
    );
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'existing@acme.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    expect(await screen.findByText(/Use Add member instead/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
