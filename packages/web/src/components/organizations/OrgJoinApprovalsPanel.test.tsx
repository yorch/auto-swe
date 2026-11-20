// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { OrgJoinApprovalsPanel } from './OrgJoinApprovalsPanel';

vi.mock('@/hooks/useEffectivePermissions', async () =>
  (await import('@/test/permissions')).permissionsMock()
);

beforeEach(() => stubDialogPrototype());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROW = {
  createdAt: '2026-11-19T10:00:00Z',
  grantedRole: 'LEAD',
  id: 'r1',
  message: 'From the data org',
  requester: { email: 'ada@other.com', name: 'Ada' },
  requiresOrgApproval: true,
  status: 'PENDING_ORG',
  teamDecisionNote: 'Welcome aboard',
  teamId: 't1',
  teamName: 'Payments',
};

describe('OrgJoinApprovalsPanel', () => {
  it('asks only for the awaiting-organization queue and shows who wants which team', async () => {
    const spy = setupFetchMock({
      '/api/v1/platform/organizations/o1/join-requests': () => ({ data: [ROW] }),
    });
    render(withQuery(<OrgJoinApprovalsPanel orgId="o1" />));
    const item = within(
      await screen.findByRole('list', { name: 'Requests awaiting organization approval' })
    ).getByRole('listitem');
    expect(within(item).getByText('Ada')).toBeTruthy();
    expect(within(item).getByText('to join Payments')).toBeTruthy();
    expect(String(spy.mock.calls[0][0])).toContain('/join-requests?status=PENDING_ORG');
  });

  it('shows the role the team granted, in the row and in the approve dialog', async () => {
    setupFetchMock({
      '/api/v1/platform/organizations/o1/join-requests': () => ({ data: [ROW] }),
    });
    render(withQuery(<OrgJoinApprovalsPanel orgId="o1" />));
    const item = within(
      await screen.findByRole('list', { name: 'Requests awaiting organization approval' })
    ).getByRole('listitem');
    expect(within(item).getByText(/Role granted by the team/)).toBeTruthy();
    expect(within(item).getByText(/Welcome aboard/)).toBeTruthy();
    fireEvent.click(within(item).getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Role granted by the team: Team lead/)).toBeTruthy();
  });

  it('approves with a note and shows no role field', async () => {
    const spy = setupFetchMock({
      '/api/v1/platform/organizations/o1/join-requests': () => ({ data: [ROW] }),
      'POST /api/v1/platform/organizations/o1/join-requests/r1/approve': () => ({ data: {} }),
    });
    render(withQuery(<OrgJoinApprovalsPanel orgId="o1" />));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(screen.queryByLabelText(/team role/i)).toBeNull();
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'ok' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' }).at(-1) as HTMLElement);
    await waitFor(() =>
      expect(bodyOf(spy, '/organizations/o1/join-requests/r1/approve')).toEqual({ note: 'ok' })
    );
  });

  it('rejects without a note', async () => {
    const spy = setupFetchMock({
      '/api/v1/platform/organizations/o1/join-requests': () => ({ data: [ROW] }),
      'POST /api/v1/platform/organizations/o1/join-requests/r1/reject': () => ({ data: {} }),
    });
    render(withQuery(<OrgJoinApprovalsPanel orgId="o1" />));
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Reject' }).at(-1) as HTMLElement);
    await waitFor(() =>
      expect(bodyOf(spy, '/organizations/o1/join-requests/r1/reject')).toEqual({})
    );
  });

  it('has an empty state', async () => {
    setupFetchMock({ '/api/v1/platform/organizations/o1/join-requests': () => ({ data: [] }) });
    render(withQuery(<OrgJoinApprovalsPanel orgId="o1" />));
    expect(await screen.findByText('No requests are waiting for approval.')).toBeTruthy();
  });
});
