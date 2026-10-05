// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
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

  describe('bearer token', () => {
    const WITH_TOKEN = { ...CONNECTION, hasToken: true };

    function mount(row: typeof CONNECTION & { hasToken?: boolean }) {
      return setupFetchMock({
        'GET /api/v1/platform/mcp-connections': () => ({ data: [row] }),
        'GET /api/v1/teams': () => ({ data: [{ id: 't1', name: 'Platform', slug: 'platform' }] }),
        'PATCH /api/v1/platform/mcp-connections/m1': () => ({ data: row }),
        'POST /api/v1/platform/mcp-connections': () => ({ data: row }),
      });
    }

    it('says whether a token is stored, without showing it', async () => {
      mount(WITH_TOKEN);
      render(withQuery(<StudioMcpConnectionsPage />));
      expect(await screen.findByText('Bearer token stored')).toBeTruthy();
    });

    it('keeps the stored token when the edit leaves the field blank', async () => {
      const spy = mount(WITH_TOKEN);
      render(withQuery(<StudioMcpConnectionsPage />));
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(spy.mock.calls.some(([, i]) => i?.method === 'PATCH')).toBe(true));
      const body = bodyOf(spy, '/mcp-connections/m1', 'PATCH') as Record<string, unknown>;
      expect(body).not.toHaveProperty('bearerToken');
      expect(body).not.toHaveProperty('clearBearerToken');
    });

    it('replaces the token when a new one is entered', async () => {
      const spy = mount(WITH_TOKEN);
      render(withQuery(<StudioMcpConnectionsPage />));
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
      const field = document.getElementById('mcp-edit-bearer-token') as HTMLInputElement;
      expect(field.type).toBe('password');
      expect(field.value).toBe('');
      fireEvent.change(field, { target: { value: 'sk-new' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(spy.mock.calls.some(([, i]) => i?.method === 'PATCH')).toBe(true));
      expect(bodyOf(spy, '/mcp-connections/m1', 'PATCH')).toMatchObject({ bearerToken: 'sk-new' });
    });

    it('clears the stored token on request', async () => {
      const spy = mount(WITH_TOKEN);
      render(withQuery(<StudioMcpConnectionsPage />));
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
      fireEvent.click(screen.getByRole('button', { name: 'Clear stored token' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(spy.mock.calls.some(([, i]) => i?.method === 'PATCH')).toBe(true));
      expect(bodyOf(spy, '/mcp-connections/m1', 'PATCH')).toMatchObject({
        clearBearerToken: true,
      });
    });

    it('offers no clear action when nothing is stored', async () => {
      mount(CONNECTION);
      render(withQuery(<StudioMcpConnectionsPage />));
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
      expect(screen.queryByRole('button', { name: 'Clear stored token' })).toBeNull();
    });

    it('sends the token with a new connection', async () => {
      const spy = mount(CONNECTION);
      render(withQuery(<StudioMcpConnectionsPage />));
      fireEvent.click(await screen.findByRole('button', { name: 'Create connection' }));
      fireEvent.change(screen.getByLabelText('Bearer token (optional)'), {
        target: { value: 'sk-created' },
      });
      expect((screen.getByLabelText('Bearer token (optional)') as HTMLInputElement).type).toBe(
        'password'
      );
      fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'n' } });
      fireEvent.change(screen.getByLabelText(/^Server URL/), {
        target: { value: 'https://mcp.example.com/mcp' },
      });
      fireEvent.submit(screen.getByLabelText(/^Name/).closest('form') as HTMLFormElement);
      await waitFor(() => expect(spy.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(true));
      expect(bodyOf(spy, '/mcp-connections')).toMatchObject({ bearerToken: 'sk-created' });
    });
  });

  describe('private network and custom headers', () => {
    const WITH_HEADERS = {
      ...CONNECTION,
      config: { allowPrivateNetwork: true, url: 'http://10.0.0.5/mcp' },
      headerNames: ['X-Api-Key'],
    };

    function mount(row: Record<string, unknown>) {
      return setupFetchMock({
        'GET /api/v1/platform/mcp-connections': () => ({ data: [row] }),
        'GET /api/v1/teams': () => ({ data: [{ id: 't1', name: 'Platform', slug: 'platform' }] }),
        'PATCH /api/v1/platform/mcp-connections/m1': () => ({ data: row }),
        'POST /api/v1/platform/mcp-connections': () => ({ data: row }),
      });
    }

    it('shows header names and the private-network flag, never values', async () => {
      mount(WITH_HEADERS);
      render(withQuery(<StudioMcpConnectionsPage />));
      expect(await screen.findByText(/Headers: X-Api-Key/)).toBeTruthy();
      expect(screen.getByText(/Private network/)).toBeTruthy();
    });

    it('keeps a stored header when its value is left blank, and shows it masked', async () => {
      const spy = mount(WITH_HEADERS);
      render(withQuery(<StudioMcpConnectionsPage />));
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
      const value = screen.getByLabelText('Header 1 value') as HTMLInputElement;
      expect(value.type).toBe('password');
      expect(value.value).toBe('');
      expect((screen.getByLabelText('Header 1 name') as HTMLInputElement).value).toBe('X-Api-Key');
      expect(
        (document.getElementById('mcp-edit-private-network') as HTMLInputElement).checked
      ).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(spy.mock.calls.some(([, i]) => i?.method === 'PATCH')).toBe(true));
      expect(bodyOf(spy, '/mcp-connections/m1', 'PATCH')).toMatchObject({
        allowPrivateNetwork: true,
        headers: [{ name: 'X-Api-Key' }],
      });
    });

    it('removes a stored header with an empty list', async () => {
      const spy = mount(WITH_HEADERS);
      render(withQuery(<StudioMcpConnectionsPage />));
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
      fireEvent.click(screen.getByRole('button', { name: /Remove header 1/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(spy.mock.calls.some(([, i]) => i?.method === 'PATCH')).toBe(true));
      expect(bodyOf(spy, '/mcp-connections/m1', 'PATCH')).toMatchObject({ headers: [] });
    });

    it('sends the flag and new headers with a new connection, and wants a value for each', async () => {
      const spy = mount(CONNECTION);
      render(withQuery(<StudioMcpConnectionsPage />));
      fireEvent.click(await screen.findByRole('button', { name: 'Create connection' }));
      fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'n' } });
      fireEvent.change(screen.getByLabelText(/^Server URL/), {
        target: { value: 'http://10.0.0.5/mcp' },
      });
      fireEvent.click(screen.getByLabelText(/This server is on a private network/));
      fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
      fireEvent.change(screen.getByLabelText('Header 1 name'), { target: { value: 'X-Tenant' } });
      const form = screen.getByLabelText(/^Name/).closest('form') as HTMLFormElement;
      fireEvent.submit(form);
      expect(await screen.findByText(/Enter a value for the X-Tenant header/)).toBeTruthy();
      expect(spy.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(false);
      fireEvent.change(screen.getByLabelText('Header 1 value'), { target: { value: 'acme' } });
      fireEvent.submit(form);
      await waitFor(() => expect(spy.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(true));
      expect(bodyOf(spy, '/mcp-connections')).toMatchObject({
        allowPrivateNetwork: true,
        headers: [{ name: 'X-Tenant', value: 'acme' }],
      });
    });

    it('stops offering Add header at five rows', async () => {
      mount(CONNECTION);
      render(withQuery(<StudioMcpConnectionsPage />));
      fireEvent.click(await screen.findByRole('button', { name: 'Create connection' }));
      for (let i = 0; i < 5; i++) {
        fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
      }
      expect(screen.queryByRole('button', { name: 'Add header' })).toBeNull();
    });
  });
});
