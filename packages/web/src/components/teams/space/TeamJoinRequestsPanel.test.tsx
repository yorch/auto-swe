// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { TeamJoinRequestsPanel } from './TeamJoinRequestsPanel';

vi.mock('@/hooks/useEffectivePermissions', async () =>
  (await import('@/test/permissions')).permissionsMock()
);

beforeEach(() => stubDialogPrototype());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const req = (over: Record<string, unknown>) => ({
  createdAt: '2026-11-19T10:00:00Z',
  id: 'r1',
  message: 'Please add me',
  requester: { email: 'ada@acme.com', name: 'Ada' },
  requiresOrgApproval: false,
  status: 'PENDING_TEAM',
  teamId: 't1',
  ...over,
});

/** Routes the two status queries apart by their query string. */
function routeByStatus(pending: unknown[], awaitingOrg: unknown[]) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        status,
      });
    if (method === 'GET' && url.includes('/teams/t1/join-requests')) {
      return json({ data: url.includes('PENDING_ORG') ? awaitingOrg : pending });
    }
    if (method === 'POST') {
      return json({ data: {} });
    }
    throw new Error(`No fetch mock for ${method} ${url}`);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('TeamJoinRequestsPanel', () => {
  it('lists open requests with requester, message and the cross-organization marker', async () => {
    routeByStatus(
      [req({}), req({ id: 'r2', requester: { email: 'bo@other.com' }, requiresOrgApproval: true })],
      []
    );
    render(
      withQuery(
        <TeamJoinRequestsPanel grantableRoles={['MEMBER']} teamId="t1" teamName="Payments" />
      )
    );
    const items = within(
      await screen.findByRole('list', { name: 'Requests awaiting a team decision' })
    ).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText('Ada')).toBeTruthy();
    expect(within(items[0]).getByText('“Please add me”')).toBeTruthy();
    expect(within(items[0]).queryByText('Also needs organization approval')).toBeNull();
    expect(within(items[1]).getByText('bo@other.com')).toBeTruthy();
    expect(within(items[1]).getByText('Also needs organization approval')).toBeTruthy();
  });

  it('approves with the chosen role and note, offering only grantable roles', async () => {
    const spy = routeByStatus([req({})], []);
    render(
      withQuery(
        <TeamJoinRequestsPanel
          grantableRoles={['LEAD', 'MEMBER']}
          teamId="t1"
          teamName="Payments"
        />
      )
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    fireEvent.click(await screen.findByRole('button', { name: /team role/i }));
    expect(screen.getAllByRole('option').map((o) => o.textContent?.replace('✓', ''))).toEqual([
      'Team member',
      'Team lead',
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'Team lead' }));
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: ' welcome ' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' }).at(-1) as HTMLElement);
    await waitFor(() =>
      expect(bodyOf(spy, '/teams/t1/join-requests/r1/approve')).toEqual({
        note: 'welcome',
        role: 'LEAD',
      })
    );
  });

  it('approves as a plain member with an empty body when nothing was chosen', async () => {
    const spy = routeByStatus([req({})], []);
    render(
      withQuery(
        <TeamJoinRequestsPanel grantableRoles={['MEMBER']} teamId="t1" teamName="Payments" />
      )
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' }).at(-1) as HTMLElement);
    await waitFor(() => expect(bodyOf(spy, '/teams/t1/join-requests/r1/approve')).toEqual({}));
  });

  it('rejects with an optional note', async () => {
    const spy = routeByStatus([req({})], []);
    render(
      withQuery(
        <TeamJoinRequestsPanel grantableRoles={['MEMBER']} teamId="t1" teamName="Payments" />
      )
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    expect(screen.queryByLabelText(/team role/i)).toBeNull();
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'not now' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Reject' }).at(-1) as HTMLElement);
    await waitFor(() =>
      expect(bodyOf(spy, '/teams/t1/join-requests/r1/reject')).toEqual({ note: 'not now' })
    );
  });

  it('lists requests waiting for the organization read-only', async () => {
    routeByStatus([], [req({ id: 'r9', requiresOrgApproval: true, status: 'PENDING_ORG' })]);
    render(
      withQuery(
        <TeamJoinRequestsPanel grantableRoles={['MEMBER']} teamId="t1" teamName="Payments" />
      )
    );
    const list = await screen.findByRole('list', {
      name: 'Requests awaiting organization approval',
    });
    expect(within(list).getByText(/waiting for organization approval/i)).toBeTruthy();
    expect(within(list).queryByRole('button')).toBeNull();
    expect(screen.getByText('No requests are waiting for a decision.')).toBeTruthy();
  });

  it('keeps the dialog open and says so when the request was already decided', async () => {
    const base = routeByStatus([req({})], []);
    const inner = base.getMockImplementation();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        (init?.method ?? 'GET').toUpperCase() === 'POST'
          ? new Response(
              JSON.stringify({ error: { code: 'REQUEST_ALREADY_DECIDED', message: 'x' } }),
              {
                headers: { 'content-type': 'application/json' },
                status: 409,
              }
            )
          : inner?.(input, init)
      )
    );
    render(
      withQuery(
        <TeamJoinRequestsPanel grantableRoles={['MEMBER']} teamId="t1" teamName="Payments" />
      )
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' }).at(-1) as HTMLElement);
    expect(await screen.findByText(/already decided or withdrawn/)).toBeTruthy();
  });
});
