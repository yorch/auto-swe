// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nav, resetNavigation } from '@/test/mockNavigation';
import {
  bodyOf,
  gatewayError,
  setupFetchMock,
  stubDialogPrototype,
  withQuery,
} from '@/test/rtl-helpers';
import { CreateTeamDialog } from './CreateTeamDialog';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

beforeEach(() => {
  stubDialogPrototype();
  resetNavigation();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ORGS = [{ id: 'o1', name: 'Acme' }];

function setup(orgs = ORGS) {
  const onClose = vi.fn();
  render(withQuery(<CreateTeamDialog creatableOrgs={orgs} onClose={onClose} open />));
  return { onClose };
}

describe('CreateTeamDialog', () => {
  it('derives the slug from the name until the slug is edited', () => {
    setup();
    const name = screen.getByLabelText(/^Name/) as HTMLInputElement;
    const slug = screen.getByLabelText(/^Slug/) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Payments Platform' } });
    expect(slug.value).toBe('payments-platform');
    fireEvent.change(slug, { target: { value: 'pay' } });
    fireEvent.change(name, { target: { value: 'Payments Platform 2' } });
    expect(slug.value).toBe('pay');
  });

  it('blocks submit on a slug that is not lowercase kebab', () => {
    setup();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Pay' } });
    fireEvent.change(screen.getByLabelText(/^Slug/), { target: { value: 'Not Valid' } });
    expect(screen.getByText(/lowercase letters, numbers and single hyphens/i)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Create team' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('creates the team in the only creatable organization and opens its space', async () => {
    const spy = setupFetchMock({
      'POST /api/v1/platform/organizations/o1/teams': () => ({
        data: { id: 't9', slug: 'payments-platform' },
      }),
    });
    const { onClose } = setup();
    expect(screen.getByText('Acme')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Payments Platform' } });
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: ' owns pay ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(bodyOf(spy, '/api/v1/platform/organizations/o1/teams')).toEqual({
      description: 'owns pay',
      name: 'Payments Platform',
      slug: 'payments-platform',
    });
    expect(nav.push).toEqual(['/teams/payments-platform']);
  });

  it('asks which organization when there are several, and offers only those', async () => {
    setup([
      { id: 'o1', name: 'Acme' },
      { id: 'o2', name: 'Globex' },
    ]);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Pay' } });
    const submit = screen.getByRole('button', { name: 'Create team' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /organization/i }));
    // The selected option carries a check mark in its text.
    expect(screen.getAllByRole('option').map((o) => o.textContent?.replace('✓', ''))).toEqual([
      'Choose organization',
      'Acme',
      'Globex',
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'Globex' }));
    expect(submit.disabled).toBe(false);
  });

  it('explains the per-user team limit and stays open', async () => {
    setupFetchMock({
      'POST /api/v1/platform/organizations/o1/teams': () => gatewayError(409, 'TEAM_LIMIT_REACHED'),
    });
    const { onClose } = setup();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Pay' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }));
    expect(await screen.findByText(/limit of teams you may create/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(nav.push).toEqual([]);
  });

  it('explains a name or slug conflict', async () => {
    setupFetchMock({
      'POST /api/v1/platform/organizations/o1/teams': () => gatewayError(409, 'TEAM_EXISTS'),
    });
    setup();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Pay' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }));
    expect(await screen.findByText(/name or slug already exists/)).toBeTruthy();
  });
});
