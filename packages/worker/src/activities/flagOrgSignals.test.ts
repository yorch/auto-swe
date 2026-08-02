import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => {
  const prismaMock = {
    slackChannel: { findUnique: vi.fn(), update: vi.fn() },
  };
  return { prisma: prismaMock };
});

const recentChannelMemoryMock = vi.fn();
const searchOrgChannelMemoryMock = vi.fn();
vi.mock('../lib/channelMemory.js', () => ({
  recentChannelMemory: (...a: unknown[]) => recentChannelMemoryMock(...a),
  searchOrgChannelMemory: (...a: unknown[]) => searchOrgChannelMemoryMock(...a),
}));

const generateEmbeddingWithSpecMock = vi.fn();
vi.mock('../lib/embeddings.js', () => ({
  generateEmbeddingWithSpec: (...a: unknown[]) => generateEmbeddingWithSpecMock(...a),
}));

const postSlackChannelMessageMock = vi.fn();
vi.mock('../lib/slackNotify.js', () => ({
  postSlackChannelMessage: (...a: unknown[]) => postSlackChannelMessageMock(...a),
}));

const runChannelAgentTurnMock = vi.fn();
/** The hold's `settle` — where the flag turn's real cost lands. */
const settleMock = vi.fn();
const reserveChannelTurnMock = vi.fn();
const isChannelOverBudgetNowMock = vi.fn();
vi.mock('./channelAssistant.js', () => ({
  isChannelOverBudgetNow: (...a: unknown[]) => isChannelOverBudgetNowMock(...a),
  reserveChannelTurn: (...a: unknown[]) => reserveChannelTurnMock(...a),
  runChannelAgentTurn: (...a: unknown[]) => runChannelAgentTurnMock(...a),
}));

import { prisma } from '@auto-swe/shared/db';
import { buildOrgFlagPrompt, flagOrgSignals, shouldPostOrgFlag } from './flagOrgSignals.js';

const findChannel = vi.mocked(prisma.slackChannel.findUnique);
const updateChannel = vi.mocked(prisma.slackChannel.update);

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    agentKey: 'channelAssistant',
    id: 'chan-1',
    isActive: true,
    lastOrgFlagCheckAt: null,
    monthlyBudgetUsdCents: null,
    orgFlaggingEnabled: true,
    orgId: 'org-1',
    personaPrompt: null,
    slackChannelId: 'C123',
    teamId: 'team-1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findChannel.mockResolvedValue(makeChannel() as never);
  updateChannel.mockResolvedValue({} as never);
  isChannelOverBudgetNowMock.mockResolvedValue(false);
  settleMock.mockResolvedValue(undefined);
  reserveChannelTurnMock.mockResolvedValue({ overBudget: false, settle: settleMock });
  recentChannelMemoryMock.mockResolvedValue([{ lessonSummary: 'we ship on fridays' }]);
  generateEmbeddingWithSpecMock.mockResolvedValue({ embedding: [0.1], spec: 'openai/x' });
  searchOrgChannelMemoryMock.mockResolvedValue([
    {
      id: 's1',
      similarity: 0.8,
      sourceChannelId: 'chan-2',
      sourceChannelName: 'payments',
      summary: 'migrating the deploy pipeline',
    },
  ]);
  runChannelAgentTurnMock.mockResolvedValue({
    costUsd: 0.01,
    reply:
      'Heads up — #payments is reworking the deploy pipeline, which may affect your Friday ships.',
  });
});

describe('shouldPostOrgFlag', () => {
  it('rejects trivial and SKIP replies, accepts substantive ones', () => {
    expect(shouldPostOrgFlag('')).toBe(false);
    expect(shouldPostOrgFlag('ok')).toBe(false);
    expect(shouldPostOrgFlag('SKIP — nothing relevant')).toBe(false);
    expect(shouldPostOrgFlag('Heads up: #payments shipped a related change.')).toBe(true);
  });
});

describe('buildOrgFlagPrompt', () => {
  it('renders this channel focus, candidate signals with source channel, and a high-bar SKIP', () => {
    const prompt = buildOrgFlagPrompt(
      ['we ship on fridays'],
      [
        {
          id: 's1',
          similarity: 0.8,
          sourceChannelId: 'c2',
          sourceChannelName: 'payments',
          summary: 'deploy rework',
        },
      ]
    );
    expect(prompt).toContain('we ship on fridays');
    expect(prompt).toContain('#payments');
    expect(prompt).toContain('deploy rework');
    expect(prompt).toContain('SKIP');
    expect(prompt).toContain('HIGH bar');
  });
});

describe('flagOrgSignals', () => {
  it('no-ops when org flagging is disabled', async () => {
    findChannel.mockResolvedValue(makeChannel({ orgFlaggingEnabled: false }) as never);
    const res = await flagOrgSignals({ channelId: 'chan-1' });
    expect(res).toEqual({ posted: false, reason: 'disabled' });
    expect(runChannelAgentTurnMock).not.toHaveBeenCalled();
  });

  it('skips the LLM while on cooldown', async () => {
    findChannel.mockResolvedValue(
      makeChannel({ lastOrgFlagCheckAt: new Date(Date.now() - 60_000) }) as never
    );
    const res = await flagOrgSignals({ channelId: 'chan-1' });
    expect(res.reason).toBe('cooldown');
    expect(searchOrgChannelMemoryMock).not.toHaveBeenCalled();
    expect(runChannelAgentTurnMock).not.toHaveBeenCalled();
  });

  it('honors a per-channel orgFlagCooldownHours override (shorter than the 20h default)', async () => {
    // 2 hours ago would still be on cooldown under the 20-hour default, but a
    // 1-hour override should have already cleared it.
    findChannel.mockResolvedValue(
      makeChannel({
        lastOrgFlagCheckAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        orgFlagCooldownHours: 1,
      }) as never
    );
    const res = await flagOrgSignals({ channelId: 'chan-1' });
    expect(res.reason).not.toBe('cooldown');
    expect(searchOrgChannelMemoryMock).toHaveBeenCalled();
  });

  it('skips when over budget', async () => {
    isChannelOverBudgetNowMock.mockResolvedValue(true);
    const res = await flagOrgSignals({ channelId: 'chan-1' });
    expect(res.reason).toBe('over-budget');
    expect(runChannelAgentTurnMock).not.toHaveBeenCalled();
  });

  it('skips cheaply when the channel has no memory to match against', async () => {
    recentChannelMemoryMock.mockResolvedValue([]);
    const res = await flagOrgSignals({ channelId: 'chan-1' });
    expect(res.reason).toBe('no-interest');
    expect(searchOrgChannelMemoryMock).not.toHaveBeenCalled();
  });

  it('stamps the cooldown even when no cross-org signals are found (no re-pay of the embedding)', async () => {
    searchOrgChannelMemoryMock.mockResolvedValue([]);
    const res = await flagOrgSignals({ channelId: 'chan-1' });
    expect(res.reason).toBe('no-signals');
    expect(runChannelAgentTurnMock).not.toHaveBeenCalled();
    // The embedding + org search already ran, so the cooldown is advanced to avoid
    // re-paying them on every ambient fire.
    const lastUpdate = updateChannel.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    expect(lastUpdate.data).toHaveProperty('lastOrgFlagCheckAt');
  });

  it('does NOT stamp the cooldown on the cheap pre-search gates (no-interest)', async () => {
    recentChannelMemoryMock.mockResolvedValue([]);
    const res = await flagOrgSignals({ channelId: 'chan-1' });
    expect(res.reason).toBe('no-interest');
    // No embedding/search happened, so nothing to throttle — leave the anchor unset
    // so the channel re-checks as soon as it gains memory.
    expect(updateChannel).not.toHaveBeenCalled();
  });

  it('posts a flag + stamps the cooldown when the agent surfaces a signal', async () => {
    const res = await flagOrgSignals({ channelId: 'chan-1' });
    expect(res).toEqual({ posted: true, reason: 'posted' });
    expect(postSlackChannelMessageMock).toHaveBeenCalledTimes(1);
    expect(settleMock).toHaveBeenCalledWith(0.01, { countRun: true });
    const lastUpdate = updateChannel.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    expect(lastUpdate.data).toHaveProperty('lastOrgFlagCheckAt');
  });

  it('does NOT post but STILL stamps the cooldown when the agent replies SKIP', async () => {
    runChannelAgentTurnMock.mockResolvedValue({ costUsd: 0.005, reply: 'SKIP' });
    const res = await flagOrgSignals({ channelId: 'chan-1' });
    expect(res).toEqual({ posted: false, reason: 'skip' });
    expect(postSlackChannelMessageMock).not.toHaveBeenCalled();
    expect(settleMock).toHaveBeenCalledWith(0.005, { countRun: false });
    // The cooldown is advanced on a SKIP too, so the next fire doesn't re-pay the LLM.
    const lastUpdate = updateChannel.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    expect(lastUpdate.data).toHaveProperty('lastOrgFlagCheckAt');
  });

  it('reports reason "error" (not "disabled") when an enabled channel throws', async () => {
    searchOrgChannelMemoryMock.mockRejectedValue(new Error('pgvector boom'));
    const res = await flagOrgSignals({ channelId: 'chan-1' });
    expect(res).toEqual({ posted: false, reason: 'error' });
  });

  it('still reports "posted" when the agent surfaced a signal but the Slack post fails', async () => {
    postSlackChannelMessageMock.mockRejectedValue(new Error('slack 429'));
    const res = await flagOrgSignals({ channelId: 'chan-1' });
    // Cost + cooldown are committed before the best-effort post, so a delivery
    // hiccup neither throws nor triggers a re-spend next fire.
    expect(res).toEqual({ posted: true, reason: 'posted' });
    const lastUpdate = updateChannel.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    expect(lastUpdate.data).toHaveProperty('lastOrgFlagCheckAt');
  });
});
