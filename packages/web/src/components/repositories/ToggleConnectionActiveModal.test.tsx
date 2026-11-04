// @vitest-environment jsdom

import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { ToggleConnectionActiveModal } from './ToggleConnectionActiveModal';

const repo = (over: Record<string, unknown> = {}) =>
  ({
    _count: { activeWorkflows: 2 },
    id: 'r1',
    isActive: true,
    name: null,
    organizationName: 'acme',
    repoName: 'api',
    team: { id: 't1', name: 'Payments', slug: 'payments' },
    type: 'git_repo',
    ...over,
  }) as unknown as RepositorySummary;

describe('ToggleConnectionActiveModal', () => {
  beforeAll(() => stubDialogPrototype());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('states the impact before deactivating, then saves isActive false', async () => {
    const fetchSpy = setupFetchMock({ 'PATCH /api/v1/repositories/r1': () => ({ data: {} }) });
    const onDone = vi.fn();
    render(
      withQuery(<ToggleConnectionActiveModal onClose={() => {}} onDone={onDone} repo={repo()} />)
    );
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate this connection?' });
    expect(within(dialog).getByText(/2 active workflows use this connection/)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('acme/api deactivated.'));
    expect(bodyOf(fetchSpy, '/api/v1/repositories/r1', 'PATCH')).toEqual({ isActive: false });
  });

  it('reactivates an inactive connection', async () => {
    const fetchSpy = setupFetchMock({ 'PATCH /api/v1/repositories/r1': () => ({ data: {} }) });
    render(
      withQuery(<ToggleConnectionActiveModal onClose={() => {}} repo={repo({ isActive: false })} />)
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Reactivate' }));
    await waitFor(() =>
      expect(bodyOf(fetchSpy, '/api/v1/repositories/r1', 'PATCH')).toEqual({ isActive: true })
    );
  });
});
