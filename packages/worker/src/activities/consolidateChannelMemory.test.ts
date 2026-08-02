import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => {
  const prismaMock = {
    $executeRawUnsafe: vi.fn(),
    $queryRawUnsafe: vi.fn(),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prismaMock)),
    channelMonthlyUsage: { findUnique: vi.fn(), upsert: vi.fn() },
    memoryItem: { updateMany: vi.fn() },
    slackChannel: { findUnique: vi.fn() },
  };
  return { prisma: prismaMock };
});

vi.mock('../lib/memoryStore.js', () => ({
  insertMemoryItem: vi.fn().mockResolvedValue('new-id'),
  searchMemoryItemsByVector: vi.fn().mockResolvedValue([]),
}));

vi.mock('@auto-swe/shared/lib/billing', () => ({
  currentYearMonth: vi.fn().mockReturnValue('2026-06'),
}));

const agentGenerateMock = vi.fn();
vi.mock('@mastra/core/agent', () => ({
  Agent: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.generate = agentGenerateMock;
  }),
}));

vi.mock('../lib/models.js', () => ({ getModel: vi.fn().mockResolvedValue({}) }));
vi.mock('../lib/config/agentSkills.js', () => ({ loadAgentSkills: vi.fn().mockResolvedValue([]) }));
vi.mock('../lib/activityContext.js', () => ({
  persistActivityTrace: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/agentTracer.js', () => ({
  AgentTracer: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.addActivityEvent = vi.fn();
    this.addLlmResponse = vi.fn();
    this.addToolCall = vi.fn();
  }),
}));
vi.mock('../lib/costTracking.js', () => ({
  recordLlmUsage: vi.fn().mockResolvedValue({
    costUsd: 0.02,
    inputTokens: 10,
    modelSpec: 'x',
    outputTokens: 5,
  }),
}));
vi.mock('../lib/embeddings.js', () => ({
  currentEmbeddingSpec: vi.fn().mockResolvedValue('openai/text-embedding-3-large'),
  generateEmbeddingWithSpec: vi.fn(),
}));

import { prisma } from '@auto-swe/shared/db';
import { consolidateChannelMemory } from './consolidateChannelMemory.js';

const findChannel = vi.mocked(prisma.slackChannel.findUnique);
const findUsage = vi.mocked(prisma.channelMonthlyUsage.findUnique);
const upsertUsage = vi.mocked(prisma.channelMonthlyUsage.upsert);
const queryRaw = vi.mocked(prisma.$queryRawUnsafe);

const CHANNEL_ID = 'chan-1';

/** Three near-identical embeddings — one cluster of three at any sane threshold. */
function memoryRows(count = 3) {
  return Array.from({ length: count }, (_, i) => ({
    embeddingJson: JSON.stringify([1, 0, 0]),
    id: `mem-${i}`,
    lessonSummary: `summary ${i}`,
    orgId: 'org-1',
    rationale: `rationale ${i}`,
    teamId: 'team-1',
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  findChannel.mockResolvedValue({
    consolidationEnabled: true,
    consolidationMinClusterSize: null,
    consolidationSimilarityThreshold: null,
    monthlyBudgetUsdCents: null,
  } as never);
  findUsage.mockResolvedValue(null as never);
  upsertUsage.mockResolvedValue({ costUsdAccrued: 0 } as never);
  queryRaw.mockResolvedValue(memoryRows() as never);
  agentGenerateMock.mockResolvedValue({
    object: { memories: [{ lessonSummary: 'merged', rationale: 'why' }] },
    usage: null,
  });
});

describe('consolidateChannelMemory', () => {
  it('is a no-op for a channel that opted out', async () => {
    findChannel.mockResolvedValue({ consolidationEnabled: false } as never);
    const result = await consolidateChannelMemory({ channelId: CHANNEL_ID });
    expect(result).toEqual({
      clustersConsolidated: 0,
      clustersFound: 0,
      memoriesConsolidated: 0,
      memoriesCreated: 0,
    });
    expect(agentGenerateMock).not.toHaveBeenCalled();
  });

  it('does not spend when the channel is already over its cap', async () => {
    findChannel.mockResolvedValue({
      consolidationEnabled: true,
      consolidationMinClusterSize: null,
      consolidationSimilarityThreshold: null,
      monthlyBudgetUsdCents: 500,
    } as never);
    findUsage.mockResolvedValue({ costUsdAccrued: 5 } as never);

    await consolidateChannelMemory({ channelId: CHANNEL_ID });

    expect(agentGenerateMock).not.toHaveBeenCalled();
    expect(upsertUsage).not.toHaveBeenCalled();
  });

  it('holds for every cluster it is about to synthesize, not just one', async () => {
    // The pass fans out one model call per qualifying cluster. A single-call
    // hold would admit an arbitrarily expensive pass on one turn's headroom.
    findChannel.mockResolvedValue({
      consolidationEnabled: true,
      consolidationMinClusterSize: 2,
      consolidationSimilarityThreshold: null,
      monthlyBudgetUsdCents: 100_000,
    } as never);
    findUsage.mockResolvedValue({ costUsdAccrued: 0 } as never);
    // Two clusters of two: rows 0/1 identical, rows 2/3 identical but orthogonal.
    queryRaw.mockResolvedValue([
      { ...memoryRows(1)[0], embeddingJson: JSON.stringify([1, 0, 0]), id: 'a' },
      { ...memoryRows(1)[0], embeddingJson: JSON.stringify([1, 0, 0]), id: 'b' },
      { ...memoryRows(1)[0], embeddingJson: JSON.stringify([0, 1, 0]), id: 'c' },
      { ...memoryRows(1)[0], embeddingJson: JSON.stringify([0, 1, 0]), id: 'd' },
    ] as never);
    upsertUsage.mockResolvedValue({ costUsdAccrued: 0.1 } as never);

    await consolidateChannelMemory({ channelId: CHANNEL_ID });

    const held = (
      upsertUsage.mock.calls[0]?.[0] as {
        update: { costUsdAccrued: { increment: number } };
      }
    ).update.costUsdAccrued.increment;
    expect(held).toBeCloseTo(0.1, 6); // two clusters × $0.05
  });

  it('writes no usage row for an uncapped channel that spent nothing', async () => {
    // `settle` is unconditional so a hold is always given back; with no cap
    // there is no hold, and materialising an all-zero row for every ambient
    // fire on every uncapped channel is pure noise.
    queryRaw.mockResolvedValue(memoryRows() as never);
    agentGenerateMock.mockResolvedValue({
      object: { memories: [{ lessonSummary: 'merged', rationale: 'why' }] },
      usage: null,
    });

    await consolidateChannelMemory({ channelId: CHANNEL_ID });

    expect(upsertUsage).not.toHaveBeenCalled();
  });
});
