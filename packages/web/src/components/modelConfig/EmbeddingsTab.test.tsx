// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { EmbeddingsTab } from './EmbeddingsTab';

const CONFIG = {
  credentialId: null,
  id: 'default',
  modelSpec: 'openai/text-embedding-3-large',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

function mock(status: { running: boolean; stale: number; total: number }) {
  return setupFetchMock({
    'GET /api/v1/platform/credentials': () => ({ data: [] }),
    'GET /api/v1/platform/embedding-config': () => ({ data: CONFIG }),
    'GET /api/v1/platform/embedding-config/reembed': () => ({
      data: { modelSpec: CONFIG.modelSpec, ...status },
    }),
    'GET /api/v1/platform/model-catalog': () => ({ data: [] }),
    'POST /api/v1/platform/embedding-config/reembed': () => ({
      data: { staleRows: status.stale, started: true },
    }),
  });
}

// The re-embed card mounts only after the config query resolves, then fetches its own status:
// two sequential fetch round trips and renders before the button exists, and the first role query
// in a file costs a few hundred ms of CPU. The finds here rely on the suite-wide
// `asyncUtilTimeout` and `testTimeout` for jsdom suites (`vitest.setup.ts`).

beforeEach(() => stubDialogPrototype());
afterEach(() => vi.unstubAllGlobals());

describe('EmbeddingsTab — re-embed older memory', () => {
  it('offers nothing when every item is embedded by the configured model', async () => {
    const spy = mock({ running: false, stale: 0, total: 40 });
    render(withQuery(<EmbeddingsTab />));
    await screen.findByText('System-wide model');
    // Absence proves nothing until the status has arrived: wait for its request, its response,
    // and a turn of the event loop for the query to settle and the card to render or not.
    const statusCall = () =>
      spy.mock.calls.findIndex(
        ([url, init]) =>
          String(url).endsWith('/embedding-config/reembed') &&
          (init as RequestInit | undefined)?.method !== 'POST'
      );
    await waitFor(() => expect(statusCall()).toBeGreaterThanOrEqual(0));
    await spy.mock.results[statusCall()]?.value;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText('Re-embed older memory')).toBeNull();
  });

  it('starts the re-embed only after confirming the cost', async () => {
    const spy = mock({ running: false, stale: 12, total: 40 });
    render(withQuery(<EmbeddingsTab />));

    fireEvent.click(await screen.findByRole('button', { name: 'Re-embed 12 items' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Re-embed memory' }));
    expect(dialog.getByText(/one embedding call per item/)).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: 'Re-embed' }));

    await waitFor(() =>
      expect(
        spy.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/embedding-config/reembed') &&
            (init as RequestInit | undefined)?.method === 'POST'
        )
      ).toBe(true)
    );
  });

  it('shows a running walk instead of the button', async () => {
    mock({ running: true, stale: 7, total: 40 });
    render(withQuery(<EmbeddingsTab />));
    expect(await screen.findByText(/Re-embedding is running/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Re-embed \d+ items/ })).toBeNull();
  });
});
