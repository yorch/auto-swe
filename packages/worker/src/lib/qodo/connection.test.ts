import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: { connection: { findFirst: vi.fn() } },
}));
vi.mock('../connectionAccess.js', () => ({ agentMayUseConnection: vi.fn() }));
vi.mock('../config/mcpConnection.js', () => ({ mcpUrlForConnection: vi.fn() }));

import { prisma } from '@auto-swe/shared/db';
import { QODO_READ_TOOLS } from '@auto-swe/shared/lib/qodoConnection';
import { mcpUrlForConnection } from '../config/mcpConnection.js';
import { agentMayUseConnection } from '../connectionAccess.js';
import { resolveQodoConnection } from './connection.js';

const findFirst = vi.mocked(prisma.connection.findFirst);
const mayUse = vi.mocked(agentMayUseConnection);
const targetOf = vi.mocked(mcpUrlForConnection);

const TARGET = {
  allowedTools: QODO_READ_TOOLS,
  scanResults: true,
  url: 'https://sdk.qodo.ai/v1/tools/mcp/',
};

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue({ id: 'conn-1' } as never);
  mayUse.mockResolvedValue('allowed');
  targetOf.mockResolvedValue(TARGET);
});

describe('resolveQodoConnection', () => {
  it("returns the run team's own marked connection with its target", async () => {
    expect(await resolveQodoConnection({ teamId: 'team-1' })).toEqual({
      connectionId: 'conn-1',
      target: TARGET,
    });
  });

  it('looks only at active mcp connections owned by that team, oldest first', async () => {
    await resolveQodoConnection({ teamId: 'team-1' });
    expect(findFirst).toHaveBeenCalledWith({
      orderBy: { createdAt: 'asc' },
      select: { id: true },
      where: {
        config: { equals: 'qodo', path: ['integration'] },
        isActive: true,
        teamId: 'team-1',
        type: 'mcp',
      },
    });
    expect(mayUse).toHaveBeenCalledWith('conn-1', { teamId: 'team-1' });
  });

  it('returns null when the team has no marked connection', async () => {
    findFirst.mockResolvedValue(null);
    expect(await resolveQodoConnection({ teamId: 'team-1' })).toBeNull();
    expect(targetOf).not.toHaveBeenCalled();
  });

  it('returns null without querying when no team identifies the caller', async () => {
    expect(await resolveQodoConnection({ teamId: '' })).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('returns null, never reading the credential, when the access check refuses or fails', async () => {
    mayUse.mockResolvedValue('refused');
    expect(await resolveQodoConnection({ teamId: 'team-1' })).toBeNull();
    mayUse.mockResolvedValue('check_failed');
    expect(await resolveQodoConnection({ teamId: 'team-1' })).toBeNull();
    expect(targetOf).not.toHaveBeenCalled();
  });

  it('returns null when the connection yields no target', async () => {
    targetOf.mockResolvedValue(null);
    expect(await resolveQodoConnection({ teamId: 'team-1' })).toBeNull();
  });

  it('never throws', async () => {
    findFirst.mockRejectedValue(new Error('db down'));
    expect(await resolveQodoConnection({ teamId: 'team-1' })).toBeNull();
  });
});
