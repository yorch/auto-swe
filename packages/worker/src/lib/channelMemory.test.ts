import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the pgvector raw-SQL surface + the helpers retrieveChannelMemory composes.
vi.mock('@auto-swe/shared/db', () => ({
  prisma: { $queryRawUnsafe: vi.fn() },
}));

const generateEmbeddingWithSpecMock = vi.fn();
vi.mock('./embeddings.js', () => ({
  generateEmbeddingWithSpec: (...args: unknown[]) => generateEmbeddingWithSpecMock(...args),
}));

const searchMemoryItemsByVectorMock = vi.fn();
vi.mock('./memoryStore.js', () => ({
  searchMemoryItemsByVector: (...args: unknown[]) => searchMemoryItemsByVectorMock(...args),
}));

import { prisma } from '@auto-swe/shared/db';
import { retrieveChannelMemory } from './channelMemory.js';

const queryRaw = vi.mocked(prisma.$queryRawUnsafe);

beforeEach(() => {
  vi.clearAllMocks();
  generateEmbeddingWithSpecMock.mockResolvedValue({ embedding: [0.1, 0.2], spec: 'openai/x' });
  // Channel-scoped search returns nothing → leaves room for the cross-channel pass.
  searchMemoryItemsByVectorMock.mockResolvedValue([]);
  queryRaw.mockResolvedValue([]);
});

describe('retrieveChannelMemory cross-channel read (Gap G)', () => {
  it('excludes private SOURCE channels from the team-scoped search SQL', async () => {
    await retrieveChannelMemory('how do we deploy?', { channelId: 'chan-1', teamId: 'team-1' });

    // The cross-channel pass runs only when teamId is set + channel results leave room.
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sql = queryRaw.mock.calls[0]?.[0] as string;
    // Gap G: a private channel's memory must never bleed into a sibling channel.
    expect(sql).toContain('JOIN slack_channels');
    expect(sql).toMatch(/sc\.is_private\s*=\s*false/);
  });

  it('does NOT run the cross-channel search when no teamId is given', async () => {
    await retrieveChannelMemory('q', { channelId: 'chan-1' });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('labels cross-channel hits and embeds the query only once', async () => {
    queryRaw.mockResolvedValue([{ id: 'm9', similarity: 0.81, summary: 'sibling fact' }]);

    const items = await retrieveChannelMemory('q', { channelId: 'chan-1', teamId: 'team-1' });

    expect(generateEmbeddingWithSpecMock).toHaveBeenCalledTimes(1); // one embed across both searches
    expect(items).toEqual([
      { crossChannel: true, id: 'm9', similarity: 0.81, summary: 'sibling fact' },
    ]);
  });
});
