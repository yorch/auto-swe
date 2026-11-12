// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { TeamFormModal } from './TeamFormModal';

beforeEach(() => {
  stubDialogPrototype();
  useAuthStore.setState({ isAuthenticated: true, user: { role: 'ADMIN', sub: 'me' } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TeamFormModal — create', () => {
  it('auto-derives a slug from the name when the slug field is left blank', async () => {
    const onClose = vi.fn();
    const spy = setupFetchMock({
      '/api/v1/teams': () => ({ data: { id: 't-new' } }),
    });

    render(withQuery(<TeamFormModal mode={{ kind: 'create' }} onClose={onClose} open={true} />));

    fireEvent.change(screen.getByLabelText(/name/i), {
      target: { value: 'Payments Platform!' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create team/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    // deriveSlug strips non-kebab chars + collapses dashes + trims
    expect(bodyOf(spy, '/api/v1/teams', 'POST')).toEqual({
      name: 'Payments Platform!',
      slug: 'payments-platform',
    });
  });

  it('uses the explicit slug when provided', async () => {
    const onClose = vi.fn();
    const spy = setupFetchMock({
      '/api/v1/teams': () => ({ data: { id: 't-new' } }),
    });

    render(withQuery(<TeamFormModal mode={{ kind: 'create' }} onClose={onClose} open={true} />));

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Anything Goes' } });
    fireEvent.change(screen.getByLabelText(/slug/i), { target: { value: 'custom-slug' } });
    fireEvent.click(screen.getByRole('button', { name: /create team/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(bodyOf(spy, '/api/v1/teams', 'POST')).toMatchObject({ slug: 'custom-slug' });
  });
});

describe('TeamFormModal — edit', () => {
  it('keeps what the user typed when the parent re-renders with an equal but new mode object', () => {
    const initial = { description: 'Owns payments', name: 'Payments' };
    const view = (
      <TeamFormModal
        mode={{ initial: { ...initial }, kind: 'edit', teamId: 't1' }}
        onClose={() => {}}
        open={true}
      />
    );
    const { rerender } = render(withQuery(view));
    const name = screen.getByLabelText(/^name/i) as HTMLInputElement;
    expect(name.value).toBe('Payments');
    fireEvent.change(name, { target: { value: 'Payments Platform' } });
    // A refetch-on-focus re-renders the parent, which builds a new `mode`.
    rerender(
      withQuery(
        <TeamFormModal
          mode={{ initial: { ...initial }, kind: 'edit', teamId: 't1' }}
          onClose={() => {}}
          open={true}
        />
      )
    );
    expect((screen.getByLabelText(/^name/i) as HTMLInputElement).value).toBe('Payments Platform');
  });
});

describe('TeamFormModal — organization admin', () => {
  it.each([
    ['TEAM_EXISTS', 'A team with this name or slug already exists. Choose another name or slug.'],
    [
      'ORG_MEMBERSHIP_REQUIRED',
      'The first admin must belong to the selected organization. Choose an organization member.',
    ],
  ])('explains %s without closing the dialog', async (code, message) => {
    const onClose = vi.fn();
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError('refused', 400, code));
    render(withQuery(<TeamFormModal mode={{ kind: 'create' }} onClose={onClose} open />));
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Payments' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('skips the single-org picker, defaults admin to creator and uses the scoped endpoint', async () => {
    useAuthStore.setState({ user: { role: 'ENGINEER', sub: 'me' } });
    const onClose = vi.fn();
    const spy = setupFetchMock({
      '/api/v1/platform/organizations': () => ({
        data: [
          { id: 'o1', name: 'Acme', role: 'ORG_ADMIN' },
          { id: 'o2', name: 'Other', role: 'ORG_MEMBER' },
        ],
      }),
      '/api/v1/platform/organizations/o1/members': () => ({ data: [] }),
      '/api/v1/platform/organizations/o1/teams': () => ({ data: { id: 't1' } }),
    });
    render(withQuery(<TeamFormModal mode={{ kind: 'create' }} onClose={onClose} open />));
    await screen.findByRole('button', { name: /first team admin/i });
    expect(screen.queryByRole('button', { name: /^organization/i })).toBeNull();
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Payments' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(bodyOf(spy, '/organizations/o1/teams')).toEqual({ name: 'Payments', slug: 'payments' });
  });

  it('offers only administered orgs and sends the selected first admin', async () => {
    useAuthStore.setState({ user: { role: 'LEAD', sub: 'me' } });
    const onClose = vi.fn();
    const spy = setupFetchMock({
      '/api/v1/platform/organizations': () => ({
        data: [
          { id: 'o1', name: 'Acme', role: 'ORG_ADMIN' },
          { id: 'o2', name: 'Beta', role: 'ORG_ADMIN' },
          { id: 'o3', name: 'Foreign', role: 'ORG_MEMBER' },
        ],
      }),
      '/api/v1/platform/organizations/o2/members': () => ({
        data: [{ user: { email: 'admin@beta.com' }, userId: 'u1' }],
      }),
      '/api/v1/platform/organizations/o2/teams': () => ({ data: { id: 't1' } }),
    });
    render(withQuery(<TeamFormModal mode={{ kind: 'create' }} onClose={onClose} open />));
    fireEvent.click(await screen.findByRole('button', { name: /organization/i }));
    expect(screen.queryByRole('option', { name: 'Foreign' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Beta' }));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: /first team admin/i }) as HTMLButtonElement).disabled
      ).toBe(false)
    );
    fireEvent.click(screen.getByRole('button', { name: /first team admin/i }));
    fireEvent.click(await screen.findByRole('option', { name: 'admin@beta.com' }));
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Beta team' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(bodyOf(spy, '/organizations/o2/teams')).toMatchObject({ adminUserId: 'u1' });
  });
});
