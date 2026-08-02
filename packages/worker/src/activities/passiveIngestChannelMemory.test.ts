import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => {
  const prismaMock = {
    slackChannel: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
  return { prisma: prismaMock };
});

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

vi.mock('../lib/config/agentSkills.js', () => ({
  loadAgentSkills: vi.fn().mockResolvedValue([]),
}));

const fetchChannelHistoryMock = vi.fn();
vi.mock('../lib/slackNotify.js', () => ({
  fetchChannelHistory: (...args: unknown[]) => fetchChannelHistoryMock(...args),
}));

const isChannelOverBudgetNowMock = vi.fn();
const accrueChannelUsageMock = vi.fn();
vi.mock('./channelAssistant.js', () => ({
  accrueChannelUsage: (...args: unknown[]) => accrueChannelUsageMock(...args),
  isChannelOverBudgetNow: (...args: unknown[]) => isChannelOverBudgetNowMock(...args),
}));

const generateEmbeddingWithSpecMock = vi.fn();
vi.mock('../lib/embeddings.js', () => ({
  generateEmbeddingWithSpec: (...args: unknown[]) => generateEmbeddingWithSpecMock(...args),
}));

const searchMemoryItemsByVectorMock = vi.fn();
const insertMemoryItemMock = vi.fn();
vi.mock('../lib/memoryStore.js', () => ({
  insertMemoryItem: (...args: unknown[]) => insertMemoryItemMock(...args),
  searchMemoryItemsByVector: (...args: unknown[]) => searchMemoryItemsByVectorMock(...args),
}));

import { prisma } from '@auto-swe/shared/db';
import { passiveIngestChannelMemory } from './passiveIngestChannelMemory.js';

const prismaMock = prisma as unknown as {
  slackChannel: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
};

const CHANNEL_ID = 'chan-uuid-1';
const CHANNEL_ROW = {
  monthlyBudgetUsdCents: null,
  orgId: 'org-1',
  passiveIngestCursor: null,
  passiveIngestEnabled: true,
  slackChannelId: 'C0TEST',
  teamId: 'team-1',
};

function makeMsg(text: string, ts: string, isBot = false) {
  return { isBot, text, ts, user: isBot ? undefined : 'U123' };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.slackChannel.findUnique.mockResolvedValue(CHANNEL_ROW);
  prismaMock.slackChannel.update.mockResolvedValue({});
  isChannelOverBudgetNowMock.mockResolvedValue(false);
  getModelMock.mockResolvedValue({});
  recordLlmUsageMock.mockResolvedValue({
    costUsd: 0.01,
    inputTokens: 100,
    modelSpec: 'test',
    outputTokens: 50,
  });
  persistActivityTraceMock.mockResolvedValue(undefined);
  accrueChannelUsageMock.mockResolvedValue(undefined);
  generateEmbeddingWithSpecMock.mockResolvedValue({
    embedding: [0.1, 0.2],
    spec: 'openai/text-embedding-3-large',
  });
  searchMemoryItemsByVectorMock.mockResolvedValue([]);
  insertMemoryItemMock.mockResolvedValue('new-memory-id');
});

describe('passiveIngestChannelMemory', () => {
  it('returns early when channel not found', async () => {
    prismaMock.slackChannel.findUnique.mockResolvedValue(null);
    const result = await passiveIngestChannelMemory({ channelId: CHANNEL_ID });
    expect(result).toEqual({ factsExtracted: 0, factsWritten: 0, messagesRead: 0 });
    expect(fetchChannelHistoryMock).not.toHaveBeenCalled();
  });

  it('returns early when passiveIngestEnabled is false', async () => {
    prismaMock.slackChannel.findUnique.mockResolvedValue({
      ...CHANNEL_ROW,
      passiveIngestEnabled: false,
    });
    const result = await passiveIngestChannelMemory({ channelId: CHANNEL_ID });
    expect(result).toEqual({ factsExtracted: 0, factsWritten: 0, messagesRead: 0 });
    expect(fetchChannelHistoryMock).not.toHaveBeenCalled();
  });

  it('returns early when over budget', async () => {
    isChannelOverBudgetNowMock.mockResolvedValue(true);
    const result = await passiveIngestChannelMemory({ channelId: CHANNEL_ID });
    expect(result).toEqual({ factsExtracted: 0, factsWritten: 0, messagesRead: 0 });
    expect(fetchChannelHistoryMock).not.toHaveBeenCalled();
  });

  it('advances cursor even when no human messages', async () => {
    fetchChannelHistoryMock.mockResolvedValue([makeMsg('bot says hi', '1700000002.000', true)]);
    agentGenerateMock.mockResolvedValue({ object: { facts: [] }, usage: null });

    const result = await passiveIngestChannelMemory({ channelId: CHANNEL_ID });
    expect(prismaMock.slackChannel.update).toHaveBeenCalledWith({
      data: { passiveIngestCursor: '1700000002.000' },
      where: { id: CHANNEL_ID },
    });
    expect(result.messagesRead).toBe(0);
  });

  it('does not advance cursor when no messages returned', async () => {
    fetchChannelHistoryMock.mockResolvedValue([]);
    const result = await passiveIngestChannelMemory({ channelId: CHANNEL_ID });
    expect(prismaMock.slackChannel.update).not.toHaveBeenCalled();
    expect(result).toEqual({ factsExtracted: 0, factsWritten: 0, messagesRead: 0 });
  });

  it('extracts and writes facts from human messages', async () => {
    fetchChannelHistoryMock.mockResolvedValue([
      makeMsg('We deploy every Monday at 9 AM UTC', '1700000001.000'),
      makeMsg('Alice owns billing', '1700000002.000'),
    ]);
    agentGenerateMock.mockResolvedValue({
      object: {
        facts: [
          {
            rationale: 'Useful for scheduling questions',
            summary: 'The team deploys every Monday at 9 AM UTC',
          },
        ],
      },
      usage: { completionTokens: 50, promptTokens: 100 },
    });

    const result = await passiveIngestChannelMemory({ channelId: CHANNEL_ID });
    expect(result.messagesRead).toBe(2);
    expect(result.factsExtracted).toBe(1);
    expect(result.factsWritten).toBe(1);
    expect(insertMemoryItemMock).toHaveBeenCalledTimes(1);
    expect(insertMemoryItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: CHANNEL_ID,
        lessonSummary: 'The team deploys every Monday at 9 AM UTC',
        scope: 'channel-memory',
      })
    );
    expect(prismaMock.slackChannel.update).toHaveBeenCalledWith({
      data: { passiveIngestCursor: '1700000002.000' },
      where: { id: CHANNEL_ID },
    });
  });

  it('skips duplicate facts when similar memory exists', async () => {
    fetchChannelHistoryMock.mockResolvedValue([makeMsg('Deploys on Monday', '1700000001.000')]);
    agentGenerateMock.mockResolvedValue({
      object: {
        facts: [{ rationale: 'scheduling', summary: 'Deploys on Monday' }],
      },
      usage: null,
    });
    // Simulate existing similar memory
    searchMemoryItemsByVectorMock.mockResolvedValue([{ id: 'existing-id' }]);

    const result = await passiveIngestChannelMemory({ channelId: CHANNEL_ID });
    expect(result.factsExtracted).toBe(1);
    expect(result.factsWritten).toBe(0);
    expect(insertMemoryItemMock).not.toHaveBeenCalled();
  });

  it('accrues cost when LLM usage is returned', async () => {
    fetchChannelHistoryMock.mockResolvedValue([makeMsg('team uses postgres', '1700000001.000')]);
    agentGenerateMock.mockResolvedValue({
      object: { facts: [{ rationale: 'db context', summary: 'team uses postgres' }] },
      usage: { completionTokens: 50, promptTokens: 100 },
    });
    recordLlmUsageMock.mockResolvedValue({
      costUsd: 0.005,
      inputTokens: 100,
      modelSpec: 'x',
      outputTokens: 50,
    });

    await passiveIngestChannelMemory({ channelId: CHANNEL_ID });
    expect(accrueChannelUsageMock).toHaveBeenCalledWith(CHANNEL_ID, 0.005, { countRun: false });
  });

  it('persists activity trace and returns empty on LLM error', async () => {
    fetchChannelHistoryMock.mockResolvedValue([makeMsg('hello', '1700000001.000')]);
    agentGenerateMock.mockRejectedValue(new Error('LLM down'));

    const result = await passiveIngestChannelMemory({ channelId: CHANNEL_ID });
    expect(result).toEqual({ factsExtracted: 0, factsWritten: 0, messagesRead: 0 });
    expect(persistActivityTraceMock).toHaveBeenCalledTimes(1);
  });

  it('uses cursor from DB when fetching history', async () => {
    prismaMock.slackChannel.findUnique.mockResolvedValue({
      ...CHANNEL_ROW,
      passiveIngestCursor: '1700000000.999',
    });
    fetchChannelHistoryMock.mockResolvedValue([]);

    await passiveIngestChannelMemory({ channelId: CHANNEL_ID });
    expect(fetchChannelHistoryMock).toHaveBeenCalledWith('C0TEST', {
      limit: 50,
      oldestTs: '1700000000.999',
    });
  });
});
