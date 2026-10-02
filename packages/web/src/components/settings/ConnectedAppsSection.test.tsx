// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { ConnectedAppsSection } from './ConnectedAppsSection';

beforeEach(stubDialogPrototype);
afterEach(() => vi.unstubAllGlobals());

const grant = (over: Record<string, unknown> = {}) => ({
  clientId: 'c1',
  clientName: 'Claude Code',
  grantedAt: new Date().toISOString(),
  redirectUris: ['http://127.0.0.1:33333/cb'],
  scopes: ['mcp:read', 'offline_access'],
  ...over,
});

describe('ConnectedAppsSection', () => {
  it('lists each app with its redirect host and what it may do', async () => {
    setupFetchMock({
      '/api/v1/me/mcp-grants': () => ({
        data: [
          grant(),
          grant({ clientId: 'c2', clientName: null, scopes: ['mcp:read', 'mcp:write'] }),
        ],
        mcp: { enabled: true, writeToolsEnabled: true },
      }),
    });
    render(withQuery(<ConnectedAppsSection />));

    expect(await screen.findByText('Claude Code')).toBeTruthy();
    expect(screen.getByText('Unnamed app')).toBeTruthy();
    expect(screen.getAllByText('127.0.0.1:33333')).toHaveLength(2);
    expect(screen.getAllByText('unverified')).toHaveLength(2);
    expect(screen.getByText('can write')).toBeTruthy();
  });

  it('disconnects an app after confirmation', async () => {
    const spy = setupFetchMock({
      'DELETE /api/v1/me/mcp-grants/c1': () => null,
      'GET /api/v1/me/mcp-grants': () => ({
        data: [grant()],
        mcp: { enabled: true, writeToolsEnabled: false },
      }),
    });
    render(withQuery(<ConnectedAppsSection />));

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

    await waitFor(() =>
      expect(
        spy.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/api/v1/me/mcp-grants/c1') &&
            (init as RequestInit).method === 'DELETE'
        )
      ).toBe(true)
    );
  });

  it('says there is nothing connected while MCP is on', async () => {
    setupFetchMock({
      '/api/v1/me/mcp-grants': () => ({
        data: [],
        mcp: { enabled: true, writeToolsEnabled: false },
      }),
    });
    render(withQuery(<ConnectedAppsSection />));
    expect(await screen.findByText(/no connected apps/i)).toBeTruthy();
  });

  it('keeps showing apps, so they can be disconnected, while MCP is off', async () => {
    setupFetchMock({
      '/api/v1/me/mcp-grants': () => ({
        data: [grant()],
        mcp: { enabled: false, writeToolsEnabled: false },
      }),
    });
    render(withQuery(<ConnectedAppsSection />));
    expect(await screen.findByText('Claude Code')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
  });

  it('renders nothing while MCP is off and nothing is connected', async () => {
    const spy = setupFetchMock({
      '/api/v1/me/mcp-grants': () => ({
        data: [],
        mcp: { enabled: false, writeToolsEnabled: false },
      }),
    });
    const { container } = render(withQuery(<ConnectedAppsSection />));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/connected apps/i)).toBeNull());
    expect(container.textContent).toBe('');
  });
});
