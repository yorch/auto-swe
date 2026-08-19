import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => {
  const prismaMock = {
    $executeRawUnsafe: vi.fn(),
    $queryRawUnsafe: vi.fn(),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prismaMock)),
    // Without these the reserve transaction throws on `channelBudgetHold.create`
    // and silently falls through to the read-only gate, which made this file's
    // hold assertions read a write a real database would have rolled back.
    channelBudgetHold: { create: vi.fn(), delete: vi.fn(), findMany: vi.fn() },
    channelMonthlyUsage: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    // Backs the config registry: no rows means `channel.memoryDedupThreshold`
    // resolves to its definition default (0.85), the previous constant.
    configSetting: { findMany: vi.fn(async () => []) },
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
const resolveAgentMock = vi.fn();
vi.mock('../lib/config/agentResolver.js', () => ({
  resolveAgent: (...args: unknown[]) => resolveAgentMock(...args),
}));
vi.mock('../lib/costTracking.js', () => ({
  // The hold is priced off this; without it every hold silently took the
  // unknown-model fallback. Opus rates, matching the spec the resolver returns.
  calculateCostUsd: (_spec: string, input: number, output: number) =>
    (input * 5 + output * 25) / 1_000_000,
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
import { loadAgentSkills } from '../lib/config/agentSkills.js';
import { getModel } from '../lib/models.js';
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
    orgId: 'org-1',
    teamId: 'team-1',
  } as never);
  findUsage.mockResolvedValue(null as never);
  upsertUsage.mockResolvedValue({ costUsdAccrued: 0 } as never);
  queryRaw.mockResolvedValue(memoryRows() as never);
  resolveAgentMock.mockResolvedValue({ model: { spec: 'anthropic/claude-opus-4-8' } });
  vi.mocked(prisma.channelBudgetHold.create).mockResolvedValue({ id: 'hold-1' } as never);
  vi.mocked(prisma.channelBudgetHold.delete).mockResolvedValue({ id: 'hold-1' } as never);
  vi.mocked(prisma.channelBudgetHold.findMany).mockResolvedValue([] as never);
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
      orgId: 'org-1',
      teamId: 'team-1',
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
      upsertUsage.mock.calls[0]?.[0] as
        | { update: { costUsdAccrued: { increment: number } } }
        | undefined
    )?.update.costUsdAccrued.increment;
    // Two clusters, priced off the bound model: 2 × (8K × $5 + 1.5K × $25) / 1M.
    expect(held).toBeCloseTo(2 * ((8_000 * 5 + 1_500 * 25) / 1_000_000), 6);
    // And the hold really was taken, rather than silently degrading to the
    // read-only gate — which is what this file used to assert against.
    expect(vi.mocked(prisma.channelBudgetHold.create)).toHaveBeenCalledTimes(1);
    const channelCtx = { channelId: CHANNEL_ID, orgId: 'org-1', teamId: 'team-1' };
    expect(resolveAgentMock).toHaveBeenCalledWith('commitToMemory', channelCtx);
    // The pass must bind at the tier its hold was priced at. The ambient
    // Temporal context has no channelId, so a channel-scoped `commitToMemory`
    // override would otherwise be priced against but never actually used.
    expect(vi.mocked(getModel)).toHaveBeenCalledWith('commitToMemory', channelCtx);
    expect(vi.mocked(loadAgentSkills)).toHaveBeenCalledWith('commitToMemory', channelCtx);
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
