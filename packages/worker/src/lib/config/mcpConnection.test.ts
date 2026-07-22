import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: { connection: { findUnique: vi.fn() } },
}));
vi.mock('./agentResolver.js', () => ({ fetchActiveAgent: vi.fn() }));

import { prisma } from '@auto-swe/shared/db';
import { fetchActiveAgent } from './agentResolver.js';
import { mcpUrlForConnection, resolveAgentMcpUrl } from './mcpConnection.js';

const findUnique = vi.mocked(prisma.connection.findUnique);
const mockedFetchActiveAgent = vi.mocked(fetchActiveAgent);

const mcpConn = (over: Record<string, unknown> = {}) => ({
  config: { url: 'https://mcp.example.com/mcp' },
  isActive: true,
  type: 'mcp',
  ...over,
});

describe('mcpUrlForConnection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null for a null id without querying', async () => {
    expect(await mcpUrlForConnection(null)).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns the url for an active mcp connection with no timeout overrides', async () => {
    findUnique.mockResolvedValue(mcpConn() as never);
    expect(await mcpUrlForConnection('c1')).toEqual({ url: 'https://mcp.example.com/mcp' });
  });

  it('returns listTimeoutMs / callTimeoutMs when set on config', async () => {
    findUnique.mockResolvedValue(
      mcpConn({
        config: {
          callTimeoutMs: 5000,
          listTimeoutMs: 2500,
          url: 'https://mcp.example.com/mcp',
        },
      }) as never
    );
    expect(await mcpUrlForConnection('c1')).toEqual({
      callTimeoutMs: 5000,
      listTimeoutMs: 2500,
      url: 'https://mcp.example.com/mcp',
    });
  });

  it('omits a timeout that is not a finite positive number (0, negative, NaN, non-number)', async () => {
    findUnique.mockResolvedValueOnce(
      mcpConn({ config: { callTimeoutMs: 0, url: 'https://mcp.example.com/mcp' } }) as never
    );
    expect(await mcpUrlForConnection('c1')).toEqual({ url: 'https://mcp.example.com/mcp' });

    findUnique.mockResolvedValueOnce(
      mcpConn({ config: { listTimeoutMs: -100, url: 'https://mcp.example.com/mcp' } }) as never
    );
    expect(await mcpUrlForConnection('c1')).toEqual({ url: 'https://mcp.example.com/mcp' });

    findUnique.mockResolvedValueOnce(
      mcpConn({ config: { callTimeoutMs: 'fast', url: 'https://mcp.example.com/mcp' } }) as never
    );
    expect(await mcpUrlForConnection('c1')).toEqual({ url: 'https://mcp.example.com/mcp' });

    findUnique.mockResolvedValueOnce(
      mcpConn({
        config: { listTimeoutMs: Number.NaN, url: 'https://mcp.example.com/mcp' },
      }) as never
    );
    expect(await mcpUrlForConnection('c1')).toEqual({ url: 'https://mcp.example.com/mcp' });
  });

  it('returns null when the connection is missing / inactive / not mcp / has no url', async () => {
    findUnique.mockResolvedValueOnce(null as never);
    expect(await mcpUrlForConnection('c1')).toBeNull();
    findUnique.mockResolvedValueOnce(mcpConn({ isActive: false }) as never);
    expect(await mcpUrlForConnection('c1')).toBeNull();
    findUnique.mockResolvedValueOnce(mcpConn({ type: 'git_repo' }) as never);
    expect(await mcpUrlForConnection('c1')).toBeNull();
    findUnique.mockResolvedValueOnce(mcpConn({ config: {} }) as never);
    expect(await mcpUrlForConnection('c1')).toBeNull();
  });

  it('never throws — a DB error yields null', async () => {
    findUnique.mockRejectedValueOnce(new Error('db down'));
    expect(await mcpUrlForConnection('c1')).toBeNull();
  });
});

describe('resolveAgentMcpUrl', () => {
  beforeEach(() => vi.clearAllMocks());

  const agent = (over: Record<string, unknown> = {}) =>
    ({ key: 'implementer', mcpConnectionId: 'c1', toolKeys: ['bash', 'mcp'], ...over }) as never;

  it('returns the target when the agent enables mcp and references an mcp connection', async () => {
    mockedFetchActiveAgent.mockResolvedValue(agent());
    findUnique.mockResolvedValue(mcpConn() as never);
    expect(await resolveAgentMcpUrl('implementer')).toEqual({
      url: 'https://mcp.example.com/mcp',
    });
  });

  it('carries the per-connection timeouts through to the agent resolution', async () => {
    mockedFetchActiveAgent.mockResolvedValue(agent());
    findUnique.mockResolvedValue(
      mcpConn({
        config: {
          callTimeoutMs: 90_000,
          listTimeoutMs: 30_000,
          url: 'https://mcp.example.com/mcp',
        },
      }) as never
    );
    expect(await resolveAgentMcpUrl('implementer')).toEqual({
      callTimeoutMs: 90_000,
      listTimeoutMs: 30_000,
      url: 'https://mcp.example.com/mcp',
    });
  });

  it('returns null when the agent does not enable mcp', async () => {
    mockedFetchActiveAgent.mockResolvedValue(agent({ toolKeys: ['bash'] }));
    expect(await resolveAgentMcpUrl('implementer')).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns null when the agent enables mcp but has no connection', async () => {
    mockedFetchActiveAgent.mockResolvedValue(agent({ mcpConnectionId: null }));
    expect(await resolveAgentMcpUrl('implementer')).toBeNull();
  });

  it('never throws — a resolution error yields null', async () => {
    mockedFetchActiveAgent.mockRejectedValueOnce(new Error('config missing'));
    expect(await resolveAgentMcpUrl('implementer')).toBeNull();
  });
});
