// @vitest-environment jsdom

import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { ShareRepoModal } from './ShareRepoModal';

const repo = {
  id: 'r1',
  name: null,
  organizationName: 'acme',
  repoName: 'api',
  shares: [{ team: { id: 't2', name: 'Platform', slug: 'platform' } }],
  team: { id: 't1', name: 'Payments', slug: 'payments' },
  type: 'git_repo',
} as unknown as RepositorySummary;

describe('ShareRepoModal', () => {
  beforeAll(() => stubDialogPrototype());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('asks before saving a selection that removes every share', async () => {
    const fetchSpy = setupFetchMock({
      'GET /api/v1/repositories/r1/share-candidates': () => ({
        data: [{ id: 't2', name: 'Platform', slug: 'platform' }],
      }),
      'PUT /api/v1/repositories/r1/shares': () => ({ data: {} }),
    });
    render(withQuery(<ShareRepoModal onClose={() => {}} repo={repo} />));
    fireEvent.click(await screen.findByLabelText('Platform'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    const dialog = await screen.findByRole('dialog', { name: 'Stop sharing this repository?' });
    expect(within(dialog).getByText(/removes access for 1 team/)).toBeTruthy();
    const wrote = () =>
      fetchSpy.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'PUT');
    expect(wrote()).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove sharing' }));
    await waitFor(() => expect(wrote()).toBe(true));
  });

  it('lists current sharees with a launch switch, and a revoked team is not saved back', async () => {
    const fetchSpy = setupFetchMock({
      'GET /api/v1/repositories/r1/share-candidates': () => ({
        data: [{ id: 't2', name: 'Platform', slug: 'platform' }],
      }),
      'PUT /api/v1/repositories/r1/shares': () => ({ data: [] }),
    });
    render(withQuery(<ShareRepoModal onClose={() => {}} repo={repo} />));
    expect(
      (await screen.findByRole('switch', { name: 'Can launch work: Platform' })).getAttribute(
        'aria-checked'
      )
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke access for Platform' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke access for Platform?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Platform') as HTMLInputElement).checked).toBe(false)
    );
    const puts = fetchSpy.mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(JSON.parse((puts[0][1] as RequestInit).body as string)).toEqual({ teamIds: [] });
  });
});
