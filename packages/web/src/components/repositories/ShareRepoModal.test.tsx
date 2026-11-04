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
});
