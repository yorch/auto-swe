import type { PrismaClient } from '@auto-swe/shared';
import { describe, expect, it, vi } from 'vitest';
import { validateMcpConnectionRef } from './agentLibraryService.js';

const ID = '22222222-2222-4222-8222-222222222222';

/** A Prisma stub whose connection lookup answers `row`. */
function prismaWith(row: Record<string, unknown> | null) {
  return { connection: { findUnique: vi.fn().mockResolvedValue(row) } } as unknown as PrismaClient;
}

const mcpConn = (over: Record<string, unknown> = {}) => ({
  id: ID,
  isActive: true,
  shares: [],
  teamId: 'team-a',
  type: 'mcp',
  ...over,
});

describe('validateMcpConnectionRef', () => {
  it("lets a TEAM agent bind its team's own connection", async () => {
    expect(
      await validateMcpConnectionRef(prismaWith(mcpConn()), ID, { scope: 'TEAM', teamId: 'team-a' })
    ).toBeNull();
  });

  it('lets a TEAM agent bind a connection shared with its team', async () => {
    const prisma = prismaWith(mcpConn({ shares: [{ teamId: 'team-b' }] }));
    expect(
      await validateMcpConnectionRef(prisma, ID, { scope: 'TEAM', teamId: 'team-b' })
    ).toBeNull();
  });

  it("refuses a TEAM agent another team's connection", async () => {
    const prisma = prismaWith(mcpConn({ shares: [{ teamId: 'team-c' }] }));
    expect(await validateMcpConnectionRef(prisma, ID, { scope: 'TEAM', teamId: 'team-b' })).toBe(
      "MCP connection is not owned by this agent's team"
    );
  });

  it('lets a GLOBAL agent save any connection (the worker checks each run)', async () => {
    expect(
      await validateMcpConnectionRef(prismaWith(mcpConn()), ID, { scope: 'GLOBAL' })
    ).toBeNull();
  });

  it('refuses an inactive or non-mcp connection', async () => {
    expect(
      await validateMcpConnectionRef(prismaWith(mcpConn({ isActive: false })), ID, {
        scope: 'GLOBAL',
      })
    ).toBe('MCP connection not found or inactive');
    expect(
      await validateMcpConnectionRef(prismaWith(mcpConn({ type: 'git_repo' })), ID, {
        scope: 'GLOBAL',
      })
    ).toBe('Referenced connection is not an mcp connection');
  });
});
