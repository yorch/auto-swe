import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: { connection: { findUnique: vi.fn() } },
}));
vi.mock('./agentResolver.js', () => ({ resolveAgent: vi.fn() }));

import { prisma } from '@auto-swe/shared/db';
import { resolveAgent } from './agentResolver.js';
import { mcpUrlForConnection, resolveAgentMcpUrl } from './mcpConnection.js';

const findUnique = vi.mocked(prisma.connection.findUnique);
const mockedResolveAgent = vi.mocked(resolveAgent);

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

  it('returns the url for an active mcp connection', async () => {
    findUnique.mockResolvedValue(mcpConn() as never);
    expect(await mcpUrlForConnection('c1')).toBe('https://mcp.example.com/mcp');
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

  it('returns the url when the agent enables mcp and references an mcp connection', async () => {
    mockedResolveAgent.mockResolvedValue(agent());
    findUnique.mockResolvedValue(mcpConn() as never);
    expect(await resolveAgentMcpUrl('implementer')).toBe('https://mcp.example.com/mcp');
  });

  it('returns null when the agent does not enable mcp', async () => {
    mockedResolveAgent.mockResolvedValue(agent({ toolKeys: ['bash'] }));
    expect(await resolveAgentMcpUrl('implementer')).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns null when the agent enables mcp but has no connection', async () => {
    mockedResolveAgent.mockResolvedValue(agent({ mcpConnectionId: null }));
    expect(await resolveAgentMcpUrl('implementer')).toBeNull();
  });
});
