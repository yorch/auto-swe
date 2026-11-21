// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { permissionsFor, resetPermissions, setPermissions } from '@/test/permissions';
import { bodyOf, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { TeamJoinRequestsPanel } from './TeamJoinRequestsPanel';

vi.mock('@/hooks/useEffectivePermissions', async () =>
  (await import('@/test/permissions')).permissionsMock()
);

beforeEach(() => stubDialogPrototype());
afterEach(() => {
  resetPermissions();
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

  describe('combined approval', () => {
    const cross = req({ orgId: 'o1', requiresOrgApproval: true });
    const open = async () => {
      render(
        withQuery(
          <TeamJoinRequestsPanel grantableRoles={['MEMBER']} teamId="t1" teamName="Payments" />
        )
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
      return screen.findByRole('dialog');
    };

    it('says the approval also completes the organization step for an organization manager', async () => {
      setPermissions(
        permissionsFor({ orgs: [{ capabilities: ['org.members.manage'], orgId: 'o1' }] })
      );
      routeByStatus([cross], []);
      const dialog = await open();
      expect(
        within(dialog).getByText(
          'You also manage this organization, so this approval completes the organization step too.'
        )
      ).toBeTruthy();
      expect(within(dialog).queryByText(/passes the request to the organization/)).toBeNull();
    });

    it('does not say it for a viewer who manages another organization, or for a same-organization request', async () => {
      setPermissions(
        permissionsFor({ orgs: [{ capabilities: ['org.members.manage'], orgId: 'o2' }] })
      );
      routeByStatus([cross], []);
      const dialog = await open();
      expect(within(dialog).queryByText(/also manage this organization/)).toBeNull();
      expect(within(dialog).getByText(/passes the request to the organization/)).toBeTruthy();
      cleanup();

      setPermissions(
        permissionsFor({ orgs: [{ capabilities: ['org.members.manage'], orgId: 'o1' }] })
      );
      routeByStatus([req({ orgId: 'o1', requiresOrgApproval: false })], []);
      const same = await open();
      expect(within(same).queryByText(/also manage this organization/)).toBeNull();
    });

    it('refetches the queues and drops the row once the approval returns APPROVED', async () => {
      setPermissions(
        permissionsFor({ orgs: [{ capabilities: ['org.members.manage'], orgId: 'o1' }] })
      );
      let approved = false;
      const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
          approved = true;
          return json({ data: { ...cross, status: 'APPROVED' } });
        }
        if (url.includes('PENDING_ORG')) {
          return json({ data: [] });
        }
        return json({ data: approved ? [] : [cross] });
      });
      vi.stubGlobal('fetch', spy);
      await open();
      fireEvent.click(screen.getAllByRole('button', { name: 'Approve' }).at(-1) as HTMLElement);
      expect(await screen.findByText('No requests are waiting for a decision.')).toBeTruthy();
      // The awaiting-organization list was read again, so the row is not left there either.
      await waitFor(() =>
        expect(spy.mock.calls.filter(([u]) => String(u).includes('PENDING_ORG')).length).toBe(2)
      );
    });
  });
});
