import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => {
  const prismaMock = {
    // The budget gate reads inside a Serializable $transaction; run the callback
    // against the same mocked client so `channelMonthlyUsage.findUnique` backs it.
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prismaMock)),
    channelMonthlyUsage: { findUnique: vi.fn(), upsert: vi.fn() },
    slackChannel: { findUnique: vi.fn(), update: vi.fn() },
  };
  return { prisma: prismaMock };
});

vi.mock('@auto-swe/shared/lib/billing', () => ({
  currentYearMonth: vi.fn().mockReturnValue('2026-06'),
}));

const resolveAgentSpecMock = vi.fn();
vi.mock('../lib/config/agentSpec.js', () => ({
  resolveAgentSpec: (...args: unknown[]) => resolveAgentSpecMock(...args),
}));

const runAgentMock = vi.fn();
vi.mock('./runAgent.js', () => ({
  runAgent: (...args: unknown[]) => runAgentMock(...args),
}));

const fetchChannelHistoryMock = vi.fn();
const postSlackChannelMessageMock = vi.fn();
vi.mock('../lib/slackNotify.js', () => ({
  fetchChannelHistory: (...args: unknown[]) => fetchChannelHistoryMock(...args),
  postSlackChannelMessage: (...args: unknown[]) => postSlackChannelMessageMock(...args),
}));

const retrieveChannelMemoryMock = vi.fn();
vi.mock('../lib/channelMemory.js', () => ({
  retrieveChannelMemory: (...args: unknown[]) => retrieveChannelMemoryMock(...args),
}));

const resolvePersonaPromptMock = vi.fn().mockResolvedValue(null);
vi.mock('../lib/channelPersona.js', () => ({
  applyPersona: (systemPrompt: string, persona: string | null) =>
    persona ? `${persona}\n\n${systemPrompt}` : systemPrompt,
  resolvePersonaPrompt: (...args: unknown[]) => resolvePersonaPromptMock(...args),
}));

import { prisma } from '@auto-swe/shared/db';
import {
  buildReactivePrompt,
  evaluateReactiveInterjection,
  shouldPostInterjection,
} from './channelReactive.js';

const findChannel = vi.mocked(prisma.slackChannel.findUnique);
const updateChannel = vi.mocked(prisma.slackChannel.update);
const findUsage = vi.mocked(prisma.channelMonthlyUsage.findUnique);

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    agentKey: 'channelAssistant',
    id: 'chan-1',
    isActive: true,
    lastReactiveAt: null,
    lastReactiveCheckAt: null,
    monthlyBudgetUsdCents: null,
    orgId: 'org-1',
    reactiveEnabled: true,
    slackChannelId: 'C123',
    teamId: 'team-1',
    ...overrides,
  };
}

function humanMsg(text: string, ts = '1700000000.000100') {
  return { isBot: false, text, ts, user: 'U1' };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveAgentSpecMock.mockResolvedValue({
    agentKey: 'channelAssistant',
    systemPrompt: '',
    tools: {},
  });
  findChannel.mockResolvedValue(makeChannel() as never);
  updateChannel.mockResolvedValue({} as never);
  findUsage.mockResolvedValue(null as never);
  retrieveChannelMemoryMock.mockResolvedValue([]);
  fetchChannelHistoryMock.mockResolvedValue([humanMsg('how do I deploy?')]);
  runAgentMock.mockResolvedValue({
    costUsd: 0.01,
    text: 'You deploy with `yarn release` from main.',
    usage: { inputTokens: 100, outputTokens: 50 },
  });
});

describe('shouldPostInterjection', () => {
  it('rejects an empty / trivial reply', () => {
    expect(shouldPostInterjection('')).toBe(false);
    expect(shouldPostInterjection('ok')).toBe(false);
  });

  it('rejects the SKIP sentinel (any decoration)', () => {
    expect(shouldPostInterjection('SKIP')).toBe(false);
    expect(shouldPostInterjection('skip — nothing to add')).toBe(false);
  });

  it('accepts a substantive reply', () => {
    expect(shouldPostInterjection('You can deploy with yarn release from main.')).toBe(true);
  });
});

describe('buildReactivePrompt', () => {
  it('renders the transcript and a high-bar SKIP instruction', () => {
    const prompt = buildReactivePrompt([humanMsg('how do I deploy?')], []);
    expect(prompt).toContain('how do I deploy?');
    expect(prompt).toContain('SKIP');
    expect(prompt).toContain('HIGH bar');
  });

  it('labels the bot vs humans and injects memory context', () => {
    const prompt = buildReactivePrompt(
      [{ isBot: true, text: 'earlier note', ts: '1', user: 'B1' }, humanMsg('a question')],
      [{ id: 'm1', similarity: 0.9, summary: 'we use yarn release' }]
    );
    expect(prompt).toContain('assistant: earlier note');
    expect(prompt).toContain('<@U1>: a question');
    expect(prompt).toContain('- we use yarn release');
  });
});

describe('evaluateReactiveInterjection', () => {
  it('no-ops (no LLM) when reactive mode is disabled', async () => {
    findChannel.mockResolvedValue(makeChannel({ reactiveEnabled: false }) as never);

    const res = await evaluateReactiveInterjection({ channelId: 'chan-1' });

    expect(res).toEqual({ posted: false, reason: 'disabled' });
    expect(fetchChannelHistoryMock).not.toHaveBeenCalled();
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it('advances the cursor without an LLM call when there are no new human messages', async () => {
    fetchChannelHistoryMock.mockResolvedValue([
      { isBot: true, text: 'bot only', ts: '1', user: 'B' },
    ]);

    const res = await evaluateReactiveInterjection({ channelId: 'chan-1' });

    expect(res.reason).toBe('no-new-messages');
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(updateChannel).toHaveBeenCalledTimes(1); // cursor advanced
  });

  it('skips the LLM when the channel is over budget', async () => {
    findChannel.mockResolvedValue(makeChannel({ monthlyBudgetUsdCents: 500 }) as never);
    findUsage.mockResolvedValue({ costUsdAccrued: 5 } as never); // $5 accrued vs $5 cap

    const res = await evaluateReactiveInterjection({ channelId: 'chan-1' });

    expect(res.reason).toBe('over-budget');
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it('skips the LLM while on cooldown (recent interjection)', async () => {
    findChannel.mockResolvedValue(
      makeChannel({ lastReactiveAt: new Date(Date.now() - 60_000) }) as never // 1 min ago
    );

    const res = await evaluateReactiveInterjection({ channelId: 'chan-1' });

    expect(res.reason).toBe('cooldown');
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it('posts an interjection + stamps the cooldown when the agent has something to add', async () => {
    const res = await evaluateReactiveInterjection({ channelId: 'chan-1' });

    expect(res).toEqual({ posted: true, reason: 'posted' });
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(postSlackChannelMessageMock).toHaveBeenCalledWith(
      'C123',
      'You deploy with `yarn release` from main.'
    );
    // Final update stamps both the cursor and the cooldown anchor.
    const lastUpdate = updateChannel.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    expect(lastUpdate.data).toHaveProperty('lastReactiveCheckAt');
    expect(lastUpdate.data).toHaveProperty('lastReactiveAt');
  });

  it('honors a per-channel reactiveCooldownMinutes override (shorter than the default)', async () => {
    // 5 minutes ago would still be on cooldown under the 10-minute default, but
    // a 1-minute override should have already cleared it.
    findChannel.mockResolvedValue(
      makeChannel({
        lastReactiveAt: new Date(Date.now() - 5 * 60_000),
        reactiveCooldownMinutes: 1,
      }) as never
    );

    const res = await evaluateReactiveInterjection({ channelId: 'chan-1' });

    expect(res.reason).not.toBe('cooldown');
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  it('honors a per-channel reactiveLookbackMinutes override when computing the fetch cursor', async () => {
    findChannel.mockResolvedValue(makeChannel({ reactiveLookbackMinutes: 5 }) as never);

    const before = Date.now();
    await evaluateReactiveInterjection({ channelId: 'chan-1' });
    const after = Date.now();

    const call = fetchChannelHistoryMock.mock.calls.at(-1);
    if (!call) {
      throw new Error('Expected channel history to be fetched');
    }
    const oldestTs = (call[1] as { oldestTs: string }).oldestTs;
    const oldestMs = parseFloat(oldestTs) * 1000;
    // Should be ~5 minutes before "now", not the 30-minute default.
    expect(oldestMs).toBeGreaterThanOrEqual(before - 5 * 60_000 - 1000);
    expect(oldestMs).toBeLessThanOrEqual(after - 5 * 60_000 + 1000);
  });

  it('does NOT post (and does not stamp cooldown) when the agent replies SKIP', async () => {
    runAgentMock.mockResolvedValue({
      costUsd: 0.005,
      text: 'SKIP',
      usage: { inputTokens: 100, outputTokens: 2 },
    });

    const res = await evaluateReactiveInterjection({ channelId: 'chan-1' });

    expect(res).toEqual({ posted: false, reason: 'skip' });
    expect(postSlackChannelMessageMock).not.toHaveBeenCalled();
    const lastUpdate = updateChannel.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    expect(lastUpdate.data).toHaveProperty('lastReactiveCheckAt');
    expect(lastUpdate.data).not.toHaveProperty('lastReactiveAt');
  });
});
