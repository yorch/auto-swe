// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import StudioMcpConnectionsPage from './page';

const CONNECTION = {
  config: { url: 'https://mcp.example.com/mcp' },
  id: 'm1',
  name: 'docs-server',
  team: { id: 't1', name: 'Platform', slug: 'platform' },
  teamId: 't1',
  usedBy: [{ key: 'reviewer', name: 'Reviewer', scope: 'GLOBAL' }],
};

beforeEach(() => stubDialogPrototype());
afterEach(() => vi.unstubAllGlobals());

describe('MCP connections page', () => {
  it('shows which agents use a connection and what Test found', async () => {
    setupFetchMock({
      'GET /api/v1/platform/mcp-connections': () => ({ data: [CONNECTION] }),
      'GET /api/v1/teams': () => ({ data: [] }),
      'POST /api/v1/platform/mcp-connections/m1/test': () => ({
        data: { durationMs: 40, ok: true, toolCount: 2, toolNames: ['search', 'fetch'] },
      }),
    });
    render(withQuery(<StudioMcpConnectionsPage />));
    expect(await screen.findByText('Reviewer')).toBeTruthy();
    expect(screen.getByText('(Platform-wide)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Reachable · 2 tools')).toBeTruthy();
    expect(screen.getByText('search, fetch')).toBeTruthy();
  });

  it('shows the reason when the server cannot be reached', async () => {
    setupFetchMock({
      'GET /api/v1/platform/mcp-connections': () => ({ data: [CONNECTION] }),
      'GET /api/v1/teams': () => ({ data: [] }),
      'POST /api/v1/platform/mcp-connections/m1/test': () => ({
        data: { durationMs: 5, error: 'Could not connect to the server.', ok: false },
      }),
    });
    render(withQuery(<StudioMcpConnectionsPage />));
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Could not connect to the server.')).toBeTruthy();
  });
});
