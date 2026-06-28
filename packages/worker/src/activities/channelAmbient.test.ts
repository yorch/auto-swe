import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => {
  const prismaMock = {
    // The budget gate reads inside a Serializable $transaction; run the callback
    // against the same mocked client so `channelMonthlyUsage.findUnique` backs it.
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prismaMock)),
    channelMonthlyUsage: { findUnique: vi.fn(), upsert: vi.fn() },
    slackChannel: { findUnique: vi.fn() },
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

const postSlackChannelMessageMock = vi.fn();
vi.mock('../lib/slackNotify.js', () => ({
  postSlackChannelMessage: (...args: unknown[]) => postSlackChannelMessageMock(...args),
}));

const recentChannelMemoryMock = vi.fn();
const writeChannelMemoryMock = vi.fn();
vi.mock('../lib/channelMemory.js', () => ({
  recentChannelMemory: (...args: unknown[]) => recentChannelMemoryMock(...args),
  writeChannelMemory: (...args: unknown[]) => writeChannelMemoryMock(...args),
}));

vi.mock('../lib/channelPersona.js', () => ({
  resolvePersonaPrompt: vi.fn().mockResolvedValue(null),
}));

// accrueChannelUsage is the real implementation (it calls prisma.channelMonthlyUsage.upsert,
// which is mocked above); isChannelOverBudget is the real pure predicate.

import { prisma } from '@auto-swe/shared/db';
import { buildAmbientPrompt, runChannelAmbientDigest, shouldPostDigest } from './channelAmbient.js';

const findChannel = vi.mocked(prisma.slackChannel.findUnique);
const findUsage = vi.mocked(prisma.channelMonthlyUsage.findUnique);
const upsertUsage = vi.mocked(prisma.channelMonthlyUsage.upsert);

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    agentKey: 'channelAssistant',
    ambientEnabled: true,
    id: 'chan-1',
    isActive: true,
    monthlyBudgetUsdCents: null,
    orgId: 'org-1',
    slackChannelId: 'C123',
    teamId: 'team-1',
    ...overrides,
  };
}

function memoryRow(summary: string) {
  return {
    createdAt: new Date('2026-06-20T00:00:00Z'),
    id: `mem-${summary}`,
    lessonSummary: summary,
    rationale: 'r',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveAgentSpecMock.mockResolvedValue({
    agentKey: 'channelAssistant',
    modelSpec: 'anthropic/claude-opus-4-8',
  });
  runAgentMock.mockResolvedValue({
    costUsd: 0.02,
    text: 'Heads up: the staging migration question from earlier is still open.',
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  recentChannelMemoryMock.mockResolvedValue([memoryRow('staging migration is pending')]);
  writeChannelMemoryMock.mockResolvedValue('mem-1');
  upsertUsage.mockResolvedValue({} as never);
});

describe('shouldPostDigest', () => {
  it('rejects empty / whitespace replies', () => {
    expect(shouldPostDigest('')).toBe(false);
    expect(shouldPostDigest('   ')).toBe(false);
  });

  it('rejects the SKIP sentinel case-insensitively after trimming', () => {
    expect(shouldPostDigest('SKIP')).toBe(false);
    expect(shouldPostDigest('  skip  ')).toBe(false);
    expect(shouldPostDigest('Skip')).toBe(false);
  });

  it('rejects a decorated SKIP reply (begins with the skip word)', () => {
    expect(shouldPostDigest('SKIP - nothing actionable today.')).toBe(false);
    expect(shouldPostDigest('skip: all clear, nothing to surface')).toBe(false);
  });

  it('still accepts a reply that merely contains "skip" mid-sentence', () => {
    expect(shouldPostDigest('We should skip the flaky test and revisit the migration.')).toBe(true);
  });

  it('rejects trivially short replies', () => {
    expect(shouldPostDigest('ok')).toBe(false);
  });

  it('accepts a substantive reply', () => {
    expect(shouldPostDigest('Here are a couple of open follow-ups worth a look.')).toBe(true);
  });
});

describe('buildAmbientPrompt', () => {
  it('includes the recent memory summaries as bullets and the SKIP instruction', () => {
    const prompt = buildAmbientPrompt([
      memoryRow('deploy needs a review'),
      memoryRow('flaky test'),
    ]);
    expect(prompt).toContain('- deploy needs a review');
    expect(prompt).toContain('- flaky test');
    expect(prompt).toContain('SKIP');
  });
});

describe('runChannelAmbientDigest', () => {
  it('posts a top-level message and accrues usage on a substantive reply', async () => {
    findChannel.mockResolvedValue(makeChannel() as never);

    await runChannelAmbientDigest({ channelId: 'chan-1' });

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(postSlackChannelMessageMock).toHaveBeenCalledTimes(1);
    expect(postSlackChannelMessageMock).toHaveBeenCalledWith(
      'C123',
      'Heads up: the staging migration question from earlier is still open.'
    );
    // Top-level post takes exactly (channel, text) — never a thread arg.
    expect(postSlackChannelMessageMock.mock.calls[0]).toHaveLength(2);
    // Usage accrued via the real accrueChannelUsage → upsert.
    expect(upsertUsage).toHaveBeenCalledTimes(1);
    const args = upsertUsage.mock.calls[0]?.[0] as {
      create: { costUsdAccrued: number };
    };
    expect(args.create.costUsdAccrued).toBeCloseTo(0.02, 6);
    // The ambient digest must NOT persist itself to channel memory — otherwise
    // each scheduled digest would be fed its own prior output (feedback loop).
    expect(writeChannelMemoryMock).not.toHaveBeenCalled();
  });

  it('does not post when the agent returns a decorated SKIP', async () => {
    findChannel.mockResolvedValue(makeChannel() as never);
    runAgentMock.mockResolvedValue({
      costUsd: 0.01,
      text: 'SKIP - nothing actionable today.',
      usage: {},
    });

    await runChannelAmbientDigest({ channelId: 'chan-1' });

    expect(postSlackChannelMessageMock).not.toHaveBeenCalled();
    // Cost is still accrued — the LLM call happened.
    expect(upsertUsage).toHaveBeenCalledTimes(1);
  });

  it('does not post on an empty reply', async () => {
    findChannel.mockResolvedValue(makeChannel() as never);
    runAgentMock.mockResolvedValue({ costUsd: 0.01, text: '   ', usage: {} });

    await runChannelAmbientDigest({ channelId: 'chan-1' });

    expect(postSlackChannelMessageMock).not.toHaveBeenCalled();
  });

  it('returns quietly without spending when over budget', async () => {
    findChannel.mockResolvedValue(makeChannel({ monthlyBudgetUsdCents: 500 }) as never);
    findUsage.mockResolvedValue({ costUsdAccrued: 5 } as never); // $5 accrued vs $5 cap

    await runChannelAmbientDigest({ channelId: 'chan-1' });

    expect(resolveAgentSpecMock).not.toHaveBeenCalled();
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(postSlackChannelMessageMock).not.toHaveBeenCalled();
    expect(recentChannelMemoryMock).not.toHaveBeenCalled();
  });

  it('runs when under budget', async () => {
    findChannel.mockResolvedValue(makeChannel({ monthlyBudgetUsdCents: 10000 }) as never);
    findUsage.mockResolvedValue({ costUsdAccrued: 1 } as never);

    await runChannelAmbientDigest({ channelId: 'chan-1' });

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(postSlackChannelMessageMock).toHaveBeenCalledTimes(1);
  });

  it('no-ops for a disabled (ambientEnabled=false) channel', async () => {
    findChannel.mockResolvedValue(makeChannel({ ambientEnabled: false }) as never);

    await runChannelAmbientDigest({ channelId: 'chan-1' });

    expect(runAgentMock).not.toHaveBeenCalled();
    expect(postSlackChannelMessageMock).not.toHaveBeenCalled();
    expect(recentChannelMemoryMock).not.toHaveBeenCalled();
  });

  it('no-ops for an inactive channel', async () => {
    findChannel.mockResolvedValue(makeChannel({ isActive: false }) as never);

    await runChannelAmbientDigest({ channelId: 'chan-1' });

    expect(runAgentMock).not.toHaveBeenCalled();
    expect(postSlackChannelMessageMock).not.toHaveBeenCalled();
  });

  it('no-ops for a missing channel', async () => {
    findChannel.mockResolvedValue(null as never);

    await runChannelAmbientDigest({ channelId: 'gone' });

    expect(runAgentMock).not.toHaveBeenCalled();
    expect(postSlackChannelMessageMock).not.toHaveBeenCalled();
  });

  it('does not run the agent when there is no recent memory', async () => {
    findChannel.mockResolvedValue(makeChannel() as never);
    recentChannelMemoryMock.mockResolvedValue([]);

    await runChannelAmbientDigest({ channelId: 'chan-1' });

    expect(runAgentMock).not.toHaveBeenCalled();
    expect(postSlackChannelMessageMock).not.toHaveBeenCalled();
  });

  it('never throws when the slack post fails', async () => {
    findChannel.mockResolvedValue(makeChannel() as never);
    postSlackChannelMessageMock.mockRejectedValue(new Error('slack down'));

    await expect(runChannelAmbientDigest({ channelId: 'chan-1' })).resolves.toBeUndefined();
  });
});
