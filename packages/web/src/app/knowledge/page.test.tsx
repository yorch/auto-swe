// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import KnowledgePage from './page';

const item = (over: Record<string, unknown> = {}) => ({
  content: 'Deploys go through the staging gate first.',
  createdAt: '2026-09-01T00:00:00.000Z',
  id: 'k1',
  provenance: null,
  status: 'UNREVIEWED',
  title: 'Deploy policy',
  trustLabel: 'Curated',
  type: 'POLICY',
  version: 3,
  visibility: 'TEAM',
  ...over,
});

function mock(rows = [item()], extra: Record<string, () => unknown> = {}) {
  return setupFetchMock({
    'GET /api/v1/knowledge': () => ({ data: rows, meta: { returned: rows.length } }),
    'GET /api/v1/knowledge/k1': () => ({ data: rows[0] }),
    'GET /api/v1/knowledge/k2': () => ({ data: rows[1] ?? rows[0] }),
    'GET /api/v1/knowledge/permissions': () => ({
      data: { canManageTeam: true, canPublishOrganization: true },
    }),
    'GET /api/v1/teams': () => ({
      data: [
        { id: 't1', name: 'Payments' },
        { id: 't2', name: 'Platform' },
      ],
    }),
    'GET /api/v1/teams/t1': () => ({ data: { orgId: 'o1' } }),
    'POST /api/v1/knowledge/k1/approve': () => ({ data: {} }),
    'POST /api/v1/knowledge/k1/reject': () => ({ data: {} }),
    ...extra,
  });
}

/** Opens a React Aria select by its label and picks an option. */
function pick(label: RegExp, option: string) {
  fireEvent.click(screen.getByRole('button', { name: label }));
  return screen.findByRole('option', { name: option }).then((o) => fireEvent.click(o));
}

beforeEach(() => {
  stubDialogPrototype();
  useAuthStore.setState({ isAuthenticated: true, user: { role: 'LEAD', sub: 'me' } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useAuthStore.setState({ isAuthenticated: false, user: null });
});

describe('Knowledge page', () => {
  it('shows humanized status and marks the opened row as current', async () => {
    mock();
    render(withQuery(<KnowledgePage />));
    const row = (await screen.findByText('Deploy policy')).closest('button') as HTMLElement;
    expect(within(row).getByText('Unreviewed')).toBeTruthy();
    expect(row.getAttribute('aria-current')).toBeNull();
    fireEvent.click(row);
    await waitFor(() => expect(row.getAttribute('aria-current')).toBe('true'));
    expect(await screen.findByRole('heading', { level: 2, name: 'Deploy policy' })).toBeTruthy();
  });

  it('asks before rejecting, names the item, and confirms the result', async () => {
    const fetchSpy = mock();
    render(withQuery(<KnowledgePage />));
    await pick(/choose a team/i, 'Payments');
    fireEvent.click((await screen.findByText('Deploy policy')).closest('button') as HTMLElement);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject this item' });
    expect(within(dialog).getByText(/Reject "Deploy policy"/)).toBeTruthy();
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/k1/reject'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Item rejected.')).toBeTruthy();
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/k1/reject'))).toBe(true);
  });

  it('does not silently overwrite an unsaved revision when another item is opened', async () => {
    const rows = [item(), item({ id: 'k2', title: 'Rollback policy' })];
    mock(rows);
    render(withQuery(<KnowledgePage />));
    await pick(/choose a team/i, 'Payments');
    fireEvent.click((await screen.findByText('Deploy policy')).closest('button') as HTMLElement);
    const title = (await screen.findByLabelText('Revised title')) as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'My half-written title' } });

    fireEvent.click(screen.getByText('Rollback policy').closest('button') as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'Discard your draft?' });
    // Keep editing: the draft is still there.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((screen.getByLabelText('Revised title') as HTMLInputElement).value).toBe(
      'My half-written title'
    );

    fireEvent.click(screen.getByText('Rollback policy').closest('button') as HTMLElement);
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Discard your draft?' })).getByRole(
        'button',
        { name: 'Discard draft' }
      )
    );
    await waitFor(() =>
      expect((screen.getByLabelText('Revised title') as HTMLInputElement).value).toBe(
        'Rollback policy'
      )
    );
  });

  it('explains how to get management actions before a team is chosen', async () => {
    mock();
    render(withQuery(<KnowledgePage />));
    await screen.findByText('Deploy policy');
    expect(screen.getByText(/Pick a team to create or review its items/)).toBeTruthy();
    expect(screen.getByText(/choose a team to see what you can do/i)).toBeTruthy();
  });
});
