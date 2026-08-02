import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => {
  const prismaMock = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prismaMock)),
    channelMonthlyUsage: { findUnique: vi.fn(), upsert: vi.fn() },
    channelOpenItem: {
      create: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    slackChannel: { findUnique: vi.fn() },
  };
  return { prisma: prismaMock };
});

vi.mock('@auto-swe/shared/lib/billing', () => ({
  currentYearMonth: vi.fn().mockReturnValue('2026-06'),
}));

const agentGenerateMock = vi.fn();
vi.mock('@mastra/core/agent', () => ({
  Agent: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.generate = agentGenerateMock;
  }),
}));

const getModelMock = vi.fn();
vi.mock('../lib/models.js', () => ({
  getModel: (...args: unknown[]) => getModelMock(...args),
}));

const recordLlmUsageMock = vi.fn();
vi.mock('../lib/costTracking.js', () => ({
  assertBudgetAvailable: vi.fn(async () => {}),
  recordLlmUsage: (...args: unknown[]) => recordLlmUsageMock(...args),
}));

const persistActivityTraceMock = vi.fn();
vi.mock('../lib/activityContext.js', () => ({
  persistActivityTrace: (...args: unknown[]) => persistActivityTraceMock(...args),
}));

vi.mock('../lib/agentTracer.js', () => ({
  AgentTracer: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.addActivityEvent = vi.fn();
    this.addLlmResponse = vi.fn();
    this.addToolCall = vi.fn();
  }),
}));

const fetchChannelHistoryMock = vi.fn();
const postSlackChannelMessageMock = vi.fn();
vi.mock('../lib/slackNotify.js', () => ({
  fetchChannelHistory: (...args: unknown[]) => fetchChannelHistoryMock(...args),
  postSlackChannelMessage: (...args: unknown[]) => postSlackChannelMessageMock(...args),
}));

vi.mock('./channelAssistant.js', () => ({
  accrueChannelUsage: vi.fn(),
  isChannelOverBudgetNow: vi.fn().mockResolvedValue(false),
}));

import { prisma } from '@auto-swe/shared/db';
import { sweepChannelOpenItems } from './channelOpenItems.js';

const findChannel = vi.mocked(prisma.slackChannel.findUnique);
const findOpenItems = vi.mocked(prisma.channelOpenItem.findMany);
const createManyOpenItems = vi.mocked(prisma.channelOpenItem.createMany);
const updateManyItems = vi.mocked(prisma.channelOpenItem.updateMany);
const updateItem = vi.mocked(prisma.channelOpenItem.update);

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    agentKey: 'channelAssistant',
    ambientEnabled: true,
    id: 'chan-1',
    isActive: true,
    monthlyBudgetUsdCents: null,
    orgId: 'org-1',
    slackChannelId: 'C0TEST',
    teamId: 'team-1',
    ...overrides,
  };
}

function makeMessages(count = 2) {
  return Array.from({ length: count }, (_, i) => ({
    isBot: false,
    text: `message ${i + 1}`,
    ts: `${1700000000 + i}.000000`,
    user: `U00${i}`,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  getModelMock.mockResolvedValue({});
  persistActivityTraceMock.mockResolvedValue(undefined);
  recordLlmUsageMock.mockResolvedValue({
    costUsd: 0.001,
    inputTokens: 100,
    modelSpec: 'anthropic/claude-sonnet-4-6',
    outputTokens: 50,
  });
  postSlackChannelMessageMock.mockResolvedValue(undefined);
  updateItem.mockResolvedValue({} as never);
  createManyOpenItems.mockResolvedValue({ count: 0 } as never);
  updateManyItems.mockResolvedValue({ count: 0 } as never);
  // Default: no existing open items, no tracked source ts
  findOpenItems.mockResolvedValue([] as never);
});

describe('sweepChannelOpenItems', () => {
  it('returns empty result when channel is inactive', async () => {
    findChannel.mockResolvedValue(makeChannel({ isActive: false }) as never);
    const result = await sweepChannelOpenItems({ channelId: 'chan-1' });
    expect(result).toEqual({ itemsCreated: 0, itemsResolved: 0, nudgesSent: 0 });
    expect(agentGenerateMock).not.toHaveBeenCalled();
  });

  it('returns empty result when ambient mode is disabled', async () => {
    findChannel.mockResolvedValue(makeChannel({ ambientEnabled: false }) as never);
    const result = await sweepChannelOpenItems({ channelId: 'chan-1' });
    expect(result).toEqual({ itemsCreated: 0, itemsResolved: 0, nudgesSent: 0 });
    expect(agentGenerateMock).not.toHaveBeenCalled();
  });

  it('returns empty result when channel is not found', async () => {
    findChannel.mockResolvedValue(null as never);
    const result = await sweepChannelOpenItems({ channelId: 'chan-1' });
    expect(result).toEqual({ itemsCreated: 0, itemsResolved: 0, nudgesSent: 0 });
  });

  it('returns empty result when no messages and no existing open items', async () => {
    findChannel.mockResolvedValue(makeChannel() as never);
    fetchChannelHistoryMock.mockResolvedValue([]);
    findOpenItems.mockResolvedValue([] as never);
    const result = await sweepChannelOpenItems({ channelId: 'chan-1' });
    expect(result).toEqual({ itemsCreated: 0, itemsResolved: 0, nudgesSent: 0 });
    expect(agentGenerateMock).not.toHaveBeenCalled();
  });

  it('creates new items detected by the LLM', async () => {
    findChannel.mockResolvedValue(makeChannel() as never);
    fetchChannelHistoryMock.mockResolvedValue(makeMessages(3));
    findOpenItems
      .mockResolvedValueOnce([] as never) // existing OPEN
      .mockResolvedValueOnce([] as never); // tracked sourceTs
    agentGenerateMock.mockResolvedValue({
      object: {
        newItems: [
          {
            description: 'Who owns the deploy?',
            ownerUserId: 'U001',
            sourceTs: '1700000001.000000',
          },
        ],
        resolvedIds: [],
      },
      usage: { completionTokens: 50, promptTokens: 100 },
    });

    const result = await sweepChannelOpenItems({ channelId: 'chan-1' });
    expect(result.itemsCreated).toBe(1);
    expect(result.itemsResolved).toBe(0);
    expect(createManyOpenItems).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          channelId: 'chan-1',
          description: 'Who owns the deploy?',
          ownerUserId: 'U001',
          sourceTs: '1700000001.000000',
        }),
      ],
    });
  });

  it('marks existing items resolved when LLM reports them', async () => {
    const existingItem = {
      createdAt: new Date(Date.now() - 25 * 3_600_000),
      description: 'Pending decision on DB migration',
      id: 'item-1',
      lastNudgedAt: null,
      ownerUserId: null,
    };
    findChannel.mockResolvedValue(makeChannel() as never);
    fetchChannelHistoryMock.mockResolvedValue(makeMessages(2));
    findOpenItems
      .mockResolvedValueOnce([existingItem] as never) // existing OPEN
      .mockResolvedValueOnce([] as never); // tracked sourceTs
    agentGenerateMock.mockResolvedValue({
      object: { newItems: [], resolvedIds: ['item-1'] },
      usage: { completionTokens: 30, promptTokens: 80 },
    });

    const result = await sweepChannelOpenItems({ channelId: 'chan-1' });
    expect(result.itemsResolved).toBe(1);
    expect(updateManyItems).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ['item-1'] } }) })
    );
  });

  it('nudges stale open items and advances lastNudgedAt', async () => {
    const staleItem = {
      createdAt: new Date(Date.now() - 26 * 3_600_000), // older than 24h
      description: 'Review PR #42',
      id: 'item-stale',
      lastNudgedAt: null, // never nudged
      ownerUserId: 'U003',
    };
    findChannel.mockResolvedValue(makeChannel() as never);
    fetchChannelHistoryMock.mockResolvedValue(makeMessages(1));
    findOpenItems.mockResolvedValueOnce([staleItem] as never).mockResolvedValueOnce([] as never);
    agentGenerateMock.mockResolvedValue({
      object: { newItems: [], resolvedIds: [] },
      usage: { completionTokens: 20, promptTokens: 60 },
    });

    const result = await sweepChannelOpenItems({ channelId: 'chan-1' });
    expect(result.nudgesSent).toBe(1);
    expect(postSlackChannelMessageMock).toHaveBeenCalledWith(
      'C0TEST',
      expect.stringContaining('Review PR #42')
    );
    expect(updateItem).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'item-stale' } })
    );
  });

  it('does not nudge an item still within the cooldown window', async () => {
    const recentlyNudged = {
      createdAt: new Date(Date.now() - 48 * 3_600_000),
      description: 'Old task',
      id: 'item-2',
      lastNudgedAt: new Date(Date.now() - 6 * 3_600_000), // nudged 6h ago < 12h cooldown
      ownerUserId: null,
    };
    findChannel.mockResolvedValue(makeChannel() as never);
    fetchChannelHistoryMock.mockResolvedValue(makeMessages(1));
    findOpenItems
      .mockResolvedValueOnce([recentlyNudged] as never)
      .mockResolvedValueOnce([] as never);
    agentGenerateMock.mockResolvedValue({
      object: { newItems: [], resolvedIds: [] },
      usage: { completionTokens: 20, promptTokens: 60 },
    });

    const result = await sweepChannelOpenItems({ channelId: 'chan-1' });
    expect(result.nudgesSent).toBe(0);
    expect(postSlackChannelMessageMock).not.toHaveBeenCalled();
  });

  it('honors a per-channel openItemNudgeAfterHours override (shorter than the 24h default)', async () => {
    // 2 hours old would NOT be stale under the 24h default, but a 1-hour
    // override should already consider it stale.
    const youngButOverridden = {
      createdAt: new Date(Date.now() - 2 * 3_600_000),
      description: 'Review PR #99',
      id: 'item-young',
      lastNudgedAt: null,
      ownerUserId: 'U004',
    };
    findChannel.mockResolvedValue(makeChannel({ openItemNudgeAfterHours: 1 }) as never);
    fetchChannelHistoryMock.mockResolvedValue(makeMessages(1));
    findOpenItems
      .mockResolvedValueOnce([youngButOverridden] as never)
      .mockResolvedValueOnce([] as never);
    agentGenerateMock.mockResolvedValue({
      object: { newItems: [], resolvedIds: [] },
      usage: { completionTokens: 20, promptTokens: 60 },
    });

    const result = await sweepChannelOpenItems({ channelId: 'chan-1' });
    expect(result.nudgesSent).toBe(1);
    expect(postSlackChannelMessageMock).toHaveBeenCalledWith(
      'C0TEST',
      expect.stringContaining('Review PR #99')
    );
  });

  it('honors a per-channel openItemNudgeCooldownHours override (shorter than the 12h default)', async () => {
    // Nudged 3h ago would still be within cooldown under the 12h default, but
    // a 1-hour override should already allow a re-nudge.
    const recentlyNudgedButOverridden = {
      createdAt: new Date(Date.now() - 48 * 3_600_000),
      description: 'Old task with override',
      id: 'item-override-cooldown',
      lastNudgedAt: new Date(Date.now() - 3 * 3_600_000),
      ownerUserId: null,
    };
    findChannel.mockResolvedValue(makeChannel({ openItemNudgeCooldownHours: 1 }) as never);
    fetchChannelHistoryMock.mockResolvedValue(makeMessages(1));
    findOpenItems
      .mockResolvedValueOnce([recentlyNudgedButOverridden] as never)
      .mockResolvedValueOnce([] as never);
    agentGenerateMock.mockResolvedValue({
      object: { newItems: [], resolvedIds: [] },
      usage: { completionTokens: 20, promptTokens: 60 },
    });

    const result = await sweepChannelOpenItems({ channelId: 'chan-1' });
    expect(result.nudgesSent).toBe(1);
    expect(postSlackChannelMessageMock).toHaveBeenCalledWith(
      'C0TEST',
      expect.stringContaining('Old task with override')
    );
  });

  it('deduplicates new items by sourceTs against already-tracked ones', async () => {
    findChannel.mockResolvedValue(makeChannel() as never);
    fetchChannelHistoryMock.mockResolvedValue(makeMessages(2));
    findOpenItems
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ sourceTs: '1700000001.000000' }] as never); // already tracked
    agentGenerateMock.mockResolvedValue({
      object: {
        newItems: [{ description: 'Already tracked item', sourceTs: '1700000001.000000' }],
        resolvedIds: [],
      },
      usage: { completionTokens: 20, promptTokens: 60 },
    });

    const result = await sweepChannelOpenItems({ channelId: 'chan-1' });
    expect(result.itemsCreated).toBe(0);
    expect(createManyOpenItems).not.toHaveBeenCalled();
  });

  it('deduplicates items without sourceTs by description against existing open items', async () => {
    const existingOpen = {
      createdAt: new Date(Date.now() - 2 * 3_600_000),
      description: 'Decide on DB migration strategy',
      id: 'item-existing',
      lastNudgedAt: null,
      ownerUserId: null,
    };
    findChannel.mockResolvedValue(makeChannel() as never);
    fetchChannelHistoryMock.mockResolvedValue(makeMessages(2));
    findOpenItems
      .mockResolvedValueOnce([existingOpen] as never) // existing OPEN
      .mockResolvedValueOnce([] as never); // tracked sourceTs (none)
    agentGenerateMock.mockResolvedValue({
      object: {
        newItems: [{ description: 'Decide on DB migration strategy' }], // no sourceTs, same description
        resolvedIds: [],
      },
      usage: { completionTokens: 20, promptTokens: 60 },
    });

    const result = await sweepChannelOpenItems({ channelId: 'chan-1' });
    expect(result.itemsCreated).toBe(0);
    expect(createManyOpenItems).not.toHaveBeenCalled();
  });

  it('returns empty on unexpected error without throwing', async () => {
    findChannel.mockRejectedValue(new Error('DB down') as never);
    const result = await sweepChannelOpenItems({ channelId: 'chan-1' });
    expect(result).toEqual({ itemsCreated: 0, itemsResolved: 0, nudgesSent: 0 });
  });
});
