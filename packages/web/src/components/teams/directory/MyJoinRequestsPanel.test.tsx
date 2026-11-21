// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { MyJoinRequestsPanel } from './MyJoinRequestsPanel';

beforeEach(() => stubDialogPrototype());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const row = (over: Record<string, unknown>) => ({
  createdAt: '2026-11-19T10:00:00Z',
  id: 'r1',
  message: '',
  orgName: 'Acme',
  requiresOrgApproval: false,
  status: 'PENDING_TEAM',
  teamId: 't1',
  teamName: 'Payments',
  teamSlug: 'payments',
  ...over,
});

describe('MyJoinRequestsPanel', () => {
  it('shows every status in words, with decision notes, and withdraw only for open ones', async () => {
    setupFetchMock({
      '/api/v1/me/join-requests': () => ({
        data: [
          row({ id: 'a', status: 'PENDING_TEAM' }),
          row({ id: 'b', status: 'PENDING_ORG', teamName: 'Data' }),
          row({
            grantedRole: 'LEAD',
            id: 'c',
            status: 'APPROVED',
            teamDecisionNote: 'Welcome aboard',
            teamName: 'Infra',
          }),
          row({
            id: 'd',
            orgDecisionNote: 'Not this quarter',
            status: 'REJECTED',
            teamName: 'Ops',
          }),
          row({ id: 'e', status: 'WITHDRAWN', teamName: 'Sec' }),
        ],
      }),
    });
    render(withQuery(<MyJoinRequestsPanel />));
    const items = within(
      await screen.findByRole('list', { name: 'Your join requests' })
    ).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    expect(within(items[0]).getByText('Pending team approval')).toBeTruthy();
    expect(within(items[1]).getByText('Pending organization approval')).toBeTruthy();
    expect(within(items[2]).getByText('Approved')).toBeTruthy();
    expect(within(items[2]).getByText('Welcome aboard')).toBeTruthy();
    expect(within(items[2]).getByText('Joined as Team lead.')).toBeTruthy();
    expect(within(items[2]).getByRole('link', { name: 'Infra' })).toBeTruthy();
    expect(within(items[3]).getByText('Rejected')).toBeTruthy();
    expect(within(items[3]).getByText('Not this quarter')).toBeTruthy();
    expect(within(items[4]).getByText('Withdrawn')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Withdraw request to/ })).toHaveLength(2);
  });

  it('withdraws after a confirmation', async () => {
    const spy = setupFetchMock({
      '/api/v1/me/join-requests': () => ({ data: [row({})] }),
      'POST /api/v1/me/join-requests/r1/withdraw': () => ({ data: row({ status: 'WITHDRAWN' }) }),
    });
    render(withQuery(<MyJoinRequestsPanel />));
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw request to Payments' }));
    // Nothing is sent until the confirmation is accepted.
    expect(spy.mock.calls.some(([, i]) => (i as RequestInit)?.method === 'POST')).toBe(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw request' }));
    await vi.waitFor(() =>
      expect(
        spy.mock.calls.some(([u]) => String(u).endsWith('/me/join-requests/r1/withdraw'))
      ).toBe(true)
    );
  });

  it('says why a request the platform closed was closed, in words', async () => {
    setupFetchMock({
      '/api/v1/me/join-requests': () => ({
        data: [
          row({ closeReason: 'TEAM_DEACTIVATED', id: 'a', status: 'REJECTED' }),
          row({ closeReason: 'REQUESTER_DEACTIVATED', id: 'b', status: 'WITHDRAWN' }),
          row({ closeReason: null, id: 'c', status: 'REJECTED' }),
        ],
      }),
    });
    render(withQuery(<MyJoinRequestsPanel />));
    const items = within(
      await screen.findByRole('list', { name: 'Your join requests' })
    ).getAllByRole('listitem');
    expect(within(items[0]).getByText('Closed automatically')).toBeTruthy();
    expect(
      within(items[0]).getByText('Closed automatically: the team was deactivated')
    ).toBeTruthy();
    expect(within(items[1]).getByText(/the requester account was deactivated/)).toBeTruthy();
    expect(within(items[2]).getByText('Rejected')).toBeTruthy();
    expect(within(items[2]).queryByText(/Closed automatically/)).toBeNull();
  });

  it('notes when the list was cut, and stays quiet otherwise or without meta', async () => {
    setupFetchMock({
      '/api/v1/me/join-requests': () => ({ data: [row({})], meta: { truncated: true } }),
    });
    const { unmount } = render(withQuery(<MyJoinRequestsPanel />));
    expect(await screen.findByText('Showing your 200 most recent requests.')).toBeTruthy();
    unmount();

    for (const body of [{ data: [row({})], meta: { truncated: false } }, { data: [row({})] }]) {
      setupFetchMock({ '/api/v1/me/join-requests': () => body });
      const view = render(withQuery(<MyJoinRequestsPanel />));
      await screen.findByRole('list', { name: 'Your join requests' });
      expect(screen.queryByText(/most recent requests/)).toBeNull();
      view.unmount();
    }
  });

  it('has an empty state', async () => {
    setupFetchMock({ '/api/v1/me/join-requests': () => ({ data: [] }) });
    render(withQuery(<MyJoinRequestsPanel />));
    expect(await screen.findByText('No requests yet')).toBeTruthy();
  });
});
