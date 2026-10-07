// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

beforeEach(() => stubDialogPrototype());
afterEach(() => vi.unstubAllGlobals());

describe('EmbeddingsTab — re-embed older memory', () => {
  it('offers nothing when every item is embedded by the configured model', async () => {
    mock({ running: false, stale: 0, total: 40 });
    render(withQuery(<EmbeddingsTab />));
    await screen.findByText('System-wide model');
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
