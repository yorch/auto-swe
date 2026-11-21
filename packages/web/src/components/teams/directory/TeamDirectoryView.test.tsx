// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bodyOf,
  gatewayError,
  setupFetchMock,
  stubDialogPrototype,
  withQuery,
} from '@/test/rtl-helpers';
import { TeamDirectoryView } from './TeamDirectoryView';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

beforeEach(() => stubDialogPrototype());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const team = (over: Record<string, unknown>) => ({
  description: 'Runs payments',
  id: 't1',
  memberCount: 4,
  name: 'Payments',
  orgId: 'o1',
  orgName: 'Acme',
  relationship: 'NONE',
  slug: 'payments',
  ...over,
});

const page = (teams: unknown[], over: Record<string, unknown> = {}) => ({
  creatableOrgs: [],
  nextCursor: null,
  scope: 'platform',
  teams,
  ...over,
});

describe('TeamDirectoryView', () => {
  it('shows each team with its organization, size and relationship', async () => {
    setupFetchMock({
      '/api/v1/teams/directory': () =>
        page([
          team({}),
          team({ id: 't2', name: 'Platform', relationship: 'MEMBER', slug: 'platform' }),
          team({ id: 't3', name: 'Data', relationship: 'REQUESTED', slug: 'data' }),
        ]),
    });
    render(withQuery(<TeamDirectoryView />));
    const list = await screen.findByRole('list', { name: 'Teams' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText('Acme')).toBeTruthy();
    expect(within(rows[0]).getByText('4 members')).toBeTruthy();
    expect(within(rows[0]).getByRole('button', { name: 'Request to join Payments' })).toBeTruthy();
    // A member and a requested team offer no request, and say why in words.
    expect(within(rows[1]).getByText('Member')).toBeTruthy();
    expect(within(rows[1]).queryByRole('button')).toBeNull();
    expect(within(rows[1]).getByRole('link', { name: 'Open Platform' })).toBeTruthy();
    expect(within(rows[2]).getByText('Requested')).toBeTruthy();
    expect(within(rows[2]).queryByRole('button')).toBeNull();
  });

  it('offers Create team only when the server names organizations to create in', async () => {
    setupFetchMock({ '/api/v1/teams/directory': () => page([team({})]) });
    const { unmount } = render(withQuery(<TeamDirectoryView />));
    await screen.findByRole('list', { name: 'Teams' });
    expect(screen.queryByRole('button', { name: 'Create team' })).toBeNull();
    unmount();

    setupFetchMock({
      '/api/v1/teams/directory': () =>
        page([team({})], { creatableOrgs: [{ id: 'o1', name: 'Acme' }] }),
    });
    render(withQuery(<TeamDirectoryView />));
    expect(await screen.findByRole('button', { name: 'Create team' })).toBeTruthy();
  });

  it('does not claim the listed teams are limited to the viewer’s organizations', async () => {
    // `scope` carries only the deployment-wide default; an organization may override it, so the
    // view must not label the list by it, even when the default is 'organization'.
    setupFetchMock({
      '/api/v1/teams/directory': () =>
        page([team({}), team({ id: 't2', orgId: 'o2', orgName: 'Zeta', slug: 'z' })], {
          scope: 'organization',
        }),
    });
    render(withQuery(<TeamDirectoryView />));
    await screen.findByRole('list', { name: 'Teams' });
    expect(screen.queryByText(/Showing teams in the organizations you belong to/)).toBeNull();
  });

  it('offers the organizations the gateway lists, and keeps them while a search loads', async () => {
    const organizations = [
      { id: 'o1', name: 'Acme' },
      { id: 'o2', name: 'Zeta' },
    ];
    const spy = setupFetchMock({
      '/api/v1/teams/directory': () => page([team({})], { organizations }),
    });
    render(withQuery(<TeamDirectoryView />));
    await screen.findByRole('list', { name: 'Teams' });
    // Only Acme appears on the page; Zeta is offered because the gateway named it.
    fireEvent.click(screen.getByRole('button', { name: /Filter by organization/ }));
    expect(screen.getAllByRole('option').map((o) => o.textContent?.replace('✓', ''))).toEqual([
      'All organizations',
      'Acme',
      'Zeta',
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'Zeta' }));
    await waitFor(() =>
      expect(spy.mock.calls.some(([u]) => String(u).includes('orgId=o2'))).toBe(true)
    );
    fireEvent.click(screen.getByRole('button', { name: /Filter by organization/ }));
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('falls back to the organizations on the page when the gateway lists none', async () => {
    setupFetchMock({
      '/api/v1/teams/directory': () =>
        page([team({}), team({ id: 't2', orgId: 'o2', orgName: 'Zeta', slug: 'z' })]),
    });
    render(withQuery(<TeamDirectoryView />));
    await screen.findByRole('list', { name: 'Teams' });
    expect(await screen.findByRole('button', { name: /Filter by organization/ })).toBeTruthy();
  });

  it('loads the next page with the cursor', async () => {
    const spy = setupFetchMock({
      '/api/v1/teams/directory': () => page([team({})], { nextCursor: 'c1' }),
    });
    render(withQuery(<TeamDirectoryView />));
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() =>
      expect(spy.mock.calls.some(([u]) => String(u).includes('cursor=c1'))).toBe(true)
    );
  });

  it('sends the search after the typing settles', async () => {
    const spy = setupFetchMock({ '/api/v1/teams/directory': () => page([team({})]) });
    render(withQuery(<TeamDirectoryView />));
    await screen.findByRole('list', { name: 'Teams' });
    fireEvent.change(screen.getByLabelText('Search the team directory'), {
      target: { value: 'pay' },
    });
    await waitFor(
      () => expect(spy.mock.calls.some(([u]) => String(u).includes('q=pay'))).toBe(true),
      { timeout: 2000 }
    );
    // One request for the settled value, not one per keystroke.
    expect(spy.mock.calls.filter(([u]) => String(u).includes('q=p&')).length).toBe(0);
  });

  it('says so when a search matches nothing', async () => {
    setupFetchMock({ '/api/v1/teams/directory': () => page([]) });
    render(withQuery(<TeamDirectoryView />));
    expect(await screen.findByText('No teams to show')).toBeTruthy();
  });

  it('sends a request with the message and confirms it', async () => {
    const spy = setupFetchMock({
      '/api/v1/teams/directory': () => page([team({})]),
      'POST /api/v1/teams/t1/join-requests': () => ({ data: { id: 'r1' } }),
    });
    render(withQuery(<TeamDirectoryView />));
    fireEvent.click(await screen.findByRole('button', { name: 'Request to join Payments' }));
    fireEvent.change(await screen.findByLabelText('Message (optional)'), {
      target: { value: '  I work on billing  ' },
    });
    expect(screen.getByText('21 / 500 characters')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText(/Request sent to Payments/)).toBeTruthy();
    expect(bodyOf(spy, '/api/v1/teams/t1/join-requests')).toEqual({ message: 'I work on billing' });
  });

  it.each([
    ['ALREADY_MEMBER', 409, {}, /already a member/],
    ['REQUEST_PENDING', 409, {}, /open request/],
    ['TOO_MANY_OPEN_REQUESTS', 429, {}, /too many open requests/],
    ['JOIN_REQUEST_COOLDOWN', 429, { retryAfterSeconds: 10_800 }, /in about 3 hours/],
    [
      'JOIN_REQUEST_COOLDOWN',
      429,
      { reason: 'withdrawn', retryAfterSeconds: 1800 },
      /You withdrew a request to this team recently\. You can ask again in 30 minutes/,
    ],
    ['TEAM_NOT_FOUND', 404, {}, /no longer available/],
  ])('keeps the dialog open and explains %s', async (code, status, details, text) => {
    setupFetchMock({
      '/api/v1/teams/directory': () => page([team({})]),
      'POST /api/v1/teams/t1/join-requests': () => gatewayError(status, code, 'raw', details),
    });
    render(withQuery(<TeamDirectoryView />));
    fireEvent.click(await screen.findByRole('button', { name: 'Request to join Payments' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send request' }));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send request' })).toBeTruthy();
  });
});
