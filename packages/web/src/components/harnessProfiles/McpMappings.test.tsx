// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';

const { setMapping, removeMapping, connections } = vi.hoisted(() => ({
  connections: { data: undefined as unknown, isError: false },
  removeMapping: vi.fn(),
  setMapping: vi.fn(),
}));
vi.mock('@/hooks/useHarnessProfiles', () => ({
  useRemoveMcpMapping: () => ({ isPending: false, mutateAsync: removeMapping }),
  useSetMcpMapping: () => ({ isPending: false, mutateAsync: setMapping }),
}));
vi.mock('@/hooks/useMcpConnections', () => ({ useMcpConnections: () => connections }));

const { McpMappings, describeMcpMappingError } = await import('./McpMappings');

const decl = (over: Record<string, unknown> = {}) => ({
  duplicate: false,
  name: 'docs',
  plugin: 'kit',
  supported: true,
  transport: 'http',
  url: 'https://mcp.example.com/x',
  ...over,
});
const mapping = (over: Record<string, unknown> = {}) => ({
  connectionId: 'c1',
  connectionName: 'Docs server',
  declared: true,
  mappedAt: '2026-11-18T00:00:00Z',
  mappedBy: null,
  serverName: 'docs',
  supported: true,
  ...over,
});
// biome-ignore lint/suspicious/noExplicitAny: partial fixtures
const profile = (over: Record<string, unknown> = {}): any => ({
  mcpMappings: [],
  mcpServers: [],
  mcpUnreadable: [],
  name: 'kit',
  status: 'OK',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  setMapping.mockResolvedValue({});
  removeMapping.mockResolvedValue({});
  connections.isError = false;
  connections.data = [
    { id: 'c1', name: 'Docs server' },
    { id: 'c2', name: 'Other server' },
  ];
});

function pick(name: string, option: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

describe('McpMappings', () => {
  it('explains that the harness never loads .mcp.json', () => {
    render(<McpMappings profile={profile()} />);
    expect(screen.getByText(/never loads a plugin’s/)).toBeTruthy();
    expect(screen.getByText('The latest version declares no MCP servers.')).toBeTruthy();
  });

  it('maps an unmapped server to a chosen connection', async () => {
    render(<McpMappings profile={profile({ mcpServers: [decl()] })} />);
    expect(screen.getByText('https://mcp.example.com/x')).toBeTruthy();
    expect(screen.getByText('http')).toBeTruthy();
    const map = screen.getByRole('button', { name: 'Map' }) as HTMLButtonElement;
    expect(map.disabled).toBe(true);
    pick('Connection for docs', 'Other server');
    fireEvent.click(map);
    await waitFor(() =>
      expect(setMapping).toHaveBeenCalledWith({
        connectionId: 'c2',
        name: 'kit',
        serverName: 'docs',
      })
    );
  });

  it('shows a mapped server with its connection name, Change and Remove', async () => {
    render(<McpMappings profile={profile({ mcpMappings: [mapping()], mcpServers: [decl()] })} />);
    expect(screen.getByText('Docs server')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Map' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove mapping for docs' }));
    await waitFor(() =>
      expect(removeMapping).toHaveBeenCalledWith({ name: 'kit', serverName: 'docs' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByRole('button', { name: 'Map' })).toBeTruthy();
  });

  it('explains an unsupported server and offers no select', () => {
    render(
      <McpMappings
        profile={profile({
          mcpServers: [decl({ supported: false, transport: 'stdio', url: null })],
        })}
      />
    );
    expect(screen.getByText(/Not loadable/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Map' })).toBeNull();
  });

  it('explains an ambiguous server and offers no select', () => {
    render(<McpMappings profile={profile({ mcpServers: [decl({ duplicate: true })] })} />);
    expect(screen.getByText(/ambiguous and cannot be mapped/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Map' })).toBeNull();
  });

  it('lists orphaned mappings separately with Remove only', async () => {
    render(
      <McpMappings
        profile={profile({ mcpMappings: [mapping({ declared: false, serverName: 'old' })] })}
      />
    );
    expect(screen.getByText('No longer declared by the latest version')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove mapping for old' }));
    await waitFor(() =>
      expect(removeMapping).toHaveBeenCalledWith({ name: 'kit', serverName: 'old' })
    );
  });

  it('lists unreadable declarations as not loaded', () => {
    render(
      <McpMappings
        profile={profile({
          mcpUnreadable: [{ file: '.mcp.json', plugin: 'kit', reason: 'file too large' }],
        })}
      />
    );
    expect(screen.getByText(/could not be read and is not loaded: file too large/)).toBeTruthy();
  });

  it('disables mapping controls while the plugin is disabled', () => {
    render(
      <McpMappings
        profile={profile({
          mcpMappings: [mapping({ serverName: 'b' })],
          mcpServers: [decl(), decl({ name: 'b' })],
          status: 'DISABLED',
        })}
      />
    );
    expect(screen.getByText(/This plugin is disabled, so its MCP mappings/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Map' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Change' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('shows the specific message for a refused mapping', async () => {
    setMapping.mockRejectedValueOnce(new ApiError('x', 400, 'MCP_CONNECTION_INVALID'));
    render(<McpMappings profile={profile({ mcpServers: [decl()] })} />);
    pick('Connection for docs', 'Other server');
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    expect(await screen.findByText(/cannot be used: it is inactive/)).toBeTruthy();
  });

  it('renders repository text as visible text', () => {
    render(<McpMappings profile={profile({ mcpServers: [decl({ name: 'a‮b', url: 'x​y' })] })} />);
    expect(document.body.textContent).not.toMatch(/[‮​]/);
  });
});

describe('describeMcpMappingError', () => {
  it.each([
    ['MCP_SERVER_NOT_DECLARED', /does not declare/],
    ['MCP_SERVER_UNSUPPORTED', /Only http/],
    ['MCP_SERVER_AMBIGUOUS', /More than one plugin/],
    ['MCP_CONNECTION_INVALID', /cannot be used/],
    ['HARNESS_PROFILE_DISABLED', /disabled/],
  ])('%s', (code, re) => {
    expect(describeMcpMappingError(new ApiError('raw', 400, code))).toMatch(re);
  });
  it('falls back for anything else', () => {
    expect(describeMcpMappingError(new Error('boom'))).toMatch(/Failed to change/);
  });
});
