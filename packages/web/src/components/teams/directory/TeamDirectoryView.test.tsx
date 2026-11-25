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

  describe('the organization filter', () => {
    const ORG_URL = '/api/v1/teams/directory/organizations';
    const orgs = (...names: string[]) => names.map((n) => ({ id: `id-${n}`, name: n }));
    const urlsOf = (spy: ReturnType<typeof vi.fn>, path: string) =>
      spy.mock.calls.map(([u]) => String(u)).filter((u) => u.includes(path));
    const filter = () => screen.getByRole('combobox', { name: 'Filter by organization' });

    it('lists the organizations the gateway names, searching the server when it opens', async () => {
      const spy = setupFetchMock({
        '/api/v1/teams/directory': () => page([team({})], { organizations: orgs('Acme', 'Zeta') }),
        [ORG_URL]: () => ({ nextCursor: null, organizations: orgs('Acme', 'Zeta') }),
      });
      render(withQuery(<TeamDirectoryView />));
      await screen.findByRole('list', { name: 'Teams' });
      fireEvent.focus(filter());
      expect(
        (await screen.findAllByRole('option')).map((o) => o.textContent?.replace('✓', ''))
      ).toEqual(['All organizations', 'Acme', 'Zeta']);
      await waitFor(() => expect(urlsOf(spy, ORG_URL).length).toBe(1));
    });

    it('stays offered when more organizations exist than the directory lists, and finds them by search', async () => {
      // One organization in the directory's own list, but it says more exist.
      const spy = setupFetchMock({
        '/api/v1/teams/directory': () =>
          page([team({})], { organizations: orgs('Acme'), organizationsTruncated: true }),
        [ORG_URL]: () => ({ nextCursor: null, organizations: orgs('Zenith') }),
      });
      render(withQuery(<TeamDirectoryView />));
      await screen.findByRole('list', { name: 'Teams' });
      fireEvent.change(filter(), { target: { value: 'zen' } });
      expect(await screen.findByRole('option', { name: 'Zenith' }, { timeout: 2000 })).toBeTruthy();
      await waitFor(
        () => expect(urlsOf(spy, ORG_URL).some((u) => u.includes('q=zen'))).toBe(true),
        { timeout: 2000 }
      );
      // One request for the settled text, not one per keystroke.
      expect(urlsOf(spy, ORG_URL).some((u) => /q=z(&|$)/.test(u))).toBe(false);
    });

    it('narrows the teams to the chosen organization and keeps showing it when it is not in the list', async () => {
      const spy = setupFetchMock({
        '/api/v1/teams/directory': () =>
          page([team({})], { organizations: orgs('Acme'), organizationsTruncated: true }),
        [ORG_URL]: () => ({ nextCursor: null, organizations: orgs('Zenith') }),
      });
      render(withQuery(<TeamDirectoryView />));
      await screen.findByRole('list', { name: 'Teams' });
      fireEvent.change(filter(), { target: { value: 'zen' } });
      fireEvent.click(await screen.findByRole('option', { name: 'Zenith' }, { timeout: 2000 }));
      await waitFor(() =>
        expect(
          urlsOf(spy, '/api/v1/teams/directory?').some((u) => u.includes('orgId=id-Zenith'))
        ).toBe(true)
      );
      // The list closed, and the chosen name is what the field shows, though the directory's own
      // list never carried it.
      expect((filter() as HTMLInputElement).value).toBe('Zenith');
      expect(screen.queryByRole('listbox')).toBeNull();
      // Clearing returns to every organization.
      fireEvent.click(screen.getByRole('button', { name: 'Clear organization filter' }));
      expect((filter() as HTMLInputElement).value).toBe('');
      expect(screen.queryByRole('button', { name: 'Clear organization filter' })).toBeNull();
    });

    it('pages the list with Load more, by cursor', async () => {
      const spy = setupFetchMock({
        '/api/v1/teams/directory': () =>
          page([team({})], { organizations: orgs('Acme', 'Beta'), organizationsTruncated: true }),
        [ORG_URL]: () => {
          const last = String(spy.mock.calls.at(-1)?.[0]);
          return last.includes('cursor=c1')
            ? { nextCursor: null, organizations: orgs('Cobalt') }
            : { nextCursor: 'c1', organizations: orgs('Acme', 'Beta') };
        },
      });
      render(withQuery(<TeamDirectoryView />));
      await screen.findByRole('list', { name: 'Teams' });
      fireEvent.focus(filter());
      fireEvent.click(await screen.findByRole('option', { name: 'Load more' }));
      expect(await screen.findByRole('option', { name: 'Cobalt' })).toBeTruthy();
      expect(urlsOf(spy, ORG_URL).some((u) => u.includes('cursor=c1'))).toBe(true);
      // The earlier pages stay, and nothing is left to load.
      expect(screen.getByRole('option', { name: 'Acme' })).toBeTruthy();
      expect(screen.queryByRole('option', { name: 'Load more' })).toBeNull();
    });

    it('works from the keyboard: arrows move, Enter chooses, Escape closes', async () => {
      const spy = setupFetchMock({
        '/api/v1/teams/directory': () => page([team({})], { organizations: orgs('Acme', 'Zeta') }),
        [ORG_URL]: () => ({ nextCursor: null, organizations: orgs('Acme', 'Zeta') }),
      });
      render(withQuery(<TeamDirectoryView />));
      await screen.findByRole('list', { name: 'Teams' });
      const input = filter();
      expect(input.getAttribute('aria-expanded')).toBe('false');
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(input.getAttribute('aria-expanded')).toBe('true');
      await screen.findByRole('option', { name: 'Zeta' });
      // Active starts on "All organizations"; two arrows reach Zeta, named by activedescendant.
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      const active = input.getAttribute('aria-activedescendant');
      expect(document.getElementById(active ?? '')?.textContent).toBe('Zeta');
      fireEvent.keyDown(input, { key: 'Enter' });
      expect((input as HTMLInputElement).value).toBe('Zeta');
      await waitFor(() =>
        expect(
          urlsOf(spy, '/api/v1/teams/directory?').some((u) => u.includes('orgId=id-Zeta'))
        ).toBe(true)
      );
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(input.getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('says so when the search fails or matches nothing', async () => {
      setupFetchMock({
        '/api/v1/teams/directory': () => page([team({})], { organizations: orgs('Acme', 'Beta') }),
        [ORG_URL]: () => ({ nextCursor: null, organizations: [] }),
      });
      render(withQuery(<TeamDirectoryView />));
      await screen.findByRole('list', { name: 'Teams' });
      fireEvent.change(filter(), { target: { value: 'nothing' } });
      expect(
        await screen.findByText('No organization matches.', {}, { timeout: 2000 })
      ).toBeTruthy();
    });
  });

  it('falls back to the organizations on the page when the gateway lists none', async () => {
    setupFetchMock({
      '/api/v1/teams/directory': () =>
        page([team({}), team({ id: 't2', orgId: 'o2', orgName: 'Zeta', slug: 'z' })]),
    });
    render(withQuery(<TeamDirectoryView />));
    await screen.findByRole('list', { name: 'Teams' });
    expect(await screen.findByRole('combobox', { name: 'Filter by organization' })).toBeTruthy();
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
