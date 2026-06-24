import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    channelMonthlyUsage: { findUnique: vi.fn(), upsert: vi.fn() },
    slackChannel: { findUnique: vi.fn() },
  },
}));

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

vi.mock('../lib/slackNotify.js', () => ({
  postSlackThreadMessage: vi.fn().mockResolvedValue(undefined),
}));

const retrieveChannelMemoryMock = vi.fn();
const writeChannelMemoryMock = vi.fn();
vi.mock('../lib/channelMemory.js', () => ({
  retrieveChannelMemory: (...args: unknown[]) => retrieveChannelMemoryMock(...args),
  writeChannelMemory: (...args: unknown[]) => writeChannelMemoryMock(...args),
}));

// Accrual now consumes the authoritative `costUsd` returned by runAgent (mocked
// here), so the channel-monthly ledger prices identically to the run-level ledger.

import { prisma } from '@auto-swe/shared/db';
import type { ChannelAssistantTurnInput } from '@auto-swe/shared/types/workflow';
import {
  formatMemoryContext,
  isChannelOverBudget,
  runChannelAssistantTurn,
} from './channelAssistant.js';

const findChannel = vi.mocked(prisma.slackChannel.findUnique);
const findUsage = vi.mocked(prisma.channelMonthlyUsage.findUnique);
const upsertUsage = vi.mocked(prisma.channelMonthlyUsage.upsert);

function makeInput(overrides: Partial<ChannelAssistantTurnInput> = {}): ChannelAssistantTurnInput {
  return {
    channelId: 'chan-1',
    orgId: 'org-1',
    slackChannelId: 'C123',
    teamId: 'team-1',
    threadTs: '111.222',
    userSlackId: 'U999',
    userText: 'hello',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveAgentSpecMock.mockResolvedValue({
    agentKey: 'channelAssistant',
    modelSpec: 'anthropic/claude-opus-4-8',
  });
  runAgentMock.mockResolvedValue({
    costUsd: 0.0175,
    inputTokens: 1000,
    outputTokens: 500,
    text: 'hi there',
    usage: { inputTokens: 1000, outputTokens: 500 },
  });
  retrieveChannelMemoryMock.mockResolvedValue([]);
  writeChannelMemoryMock.mockResolvedValue('mem-1');
});

describe('isChannelOverBudget', () => {
  it('returns false when no cap is set', () => {
    expect(isChannelOverBudget(100, null)).toBe(false);
    expect(isChannelOverBudget(100, undefined)).toBe(false);
    expect(isChannelOverBudget(100, 0)).toBe(false);
  });

  it('compares accrued USD against the cap in cents', () => {
    // $4.99 accrued vs $5.00 cap (500c) → under
    expect(isChannelOverBudget(4.99, 500)).toBe(false);
    // $5.00 accrued vs $5.00 cap → at cap → over
    expect(isChannelOverBudget(5, 500)).toBe(true);
    // $6.00 accrued vs $5.00 cap → over
    expect(isChannelOverBudget(6, 500)).toBe(true);
  });
});

describe('formatMemoryContext', () => {
  it('returns the user text unchanged when there are no items', () => {
    expect(formatMemoryContext([], 'what is the deploy command?')).toBe(
      'what is the deploy command?'
    );
  });

  it('prepends a bulleted context block above the original user text', () => {
    const out = formatMemoryContext(
      [
        { id: 'a', similarity: 0.9, summary: 'deploy with yarn release' },
        { id: 'b', similarity: 0.8, summary: 'staging is on port 8080' },
      ],
      'how do I deploy?'
    );
    expect(out).toContain("Relevant context from this channel's memory:");
    expect(out).toContain('- deploy with yarn release');
    expect(out).toContain('- staging is on port 8080');
    // Original text is kept intact below the context block.
    expect(out).toContain('User: how do I deploy?');
  });

  it('caps the injected items at 5', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      id: `i${i}`,
      similarity: 0.9,
      summary: `fact ${i}`,
    }));
    const out = formatMemoryContext(items, 'q');
    expect(out.match(/- fact \d/g)?.length).toBe(5);
  });
});

describe('runChannelAssistantTurn', () => {
  it('skips the LLM call and returns the budget message when the cap is reached', async () => {
    findChannel.mockResolvedValue({
      agentKey: 'channelAssistant',
      monthlyBudgetUsdCents: 500,
    } as never);
    // $5.00 accrued, cap $5.00 → at/over budget.
    findUsage.mockResolvedValue({ costUsdAccrued: 5 } as never);

    const result = await runChannelAssistantTurn(makeInput());

    expect(result.reply).toContain('monthly assistant budget');
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(resolveAgentSpecMock).not.toHaveBeenCalled();
    expect(upsertUsage).not.toHaveBeenCalled();
  });

  it('runs the turn when under budget and accrues channel usage', async () => {
    findChannel.mockResolvedValue({
      agentKey: 'channelAssistant',
      monthlyBudgetUsdCents: 10000, // $100 cap
    } as never);
    findUsage.mockResolvedValue({ costUsdAccrued: 1 } as never); // $1 accrued

    const result = await runChannelAssistantTurn(makeInput());

    expect(result.reply).toBe('hi there');
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(upsertUsage).toHaveBeenCalledTimes(1);
    const args = upsertUsage.mock.calls[0]?.[0] as {
      create: { costUsdAccrued: number; runsCompleted: number; channelId: string };
      update: { costUsdAccrued: { increment: number }; runsCompleted: { increment: number } };
      where: { channelId_yearMonth: { channelId: string; yearMonth: string } };
    };
    // Accrual uses the authoritative `costUsd` returned by runAgent (not a
    // local re-pricing of token usage), keeping the per-channel ledger in lockstep
    // with the run-level ledger.
    expect(args.create.costUsdAccrued).toBeCloseTo(0.0175, 6);
    expect(args.update.costUsdAccrued).toEqual({ increment: 0.0175 });
    expect(args.create.runsCompleted).toBe(1);
    expect(args.update.runsCompleted).toEqual({ increment: 1 });
    expect(args.where.channelId_yearMonth.yearMonth).toBe('2026-06');
  });

  it('does not read usage or block when no cap is set', async () => {
    findChannel.mockResolvedValue({
      agentKey: 'channelAssistant',
      monthlyBudgetUsdCents: null,
    } as never);

    const result = await runChannelAssistantTurn(makeInput());

    expect(findUsage).not.toHaveBeenCalled();
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe('hi there');
  });

  it('still returns the reply when usage accrual fails (best-effort)', async () => {
    findChannel.mockResolvedValue({
      agentKey: 'channelAssistant',
      monthlyBudgetUsdCents: null,
    } as never);
    upsertUsage.mockRejectedValue(new Error('db down'));

    const result = await runChannelAssistantTurn(makeInput());

    expect(result.reply).toBe('hi there');
  });

  it('injects retrieved channel memory into the message passed to runAgent', async () => {
    findChannel.mockResolvedValue({
      agentKey: 'channelAssistant',
      monthlyBudgetUsdCents: null,
    } as never);
    retrieveChannelMemoryMock.mockResolvedValue([
      { id: 'a', similarity: 0.9, summary: 'we deploy with yarn release' },
    ]);

    await runChannelAssistantTurn(makeInput({ userText: 'how do I deploy?' }));

    expect(retrieveChannelMemoryMock).toHaveBeenCalledWith('how do I deploy?', {
      channelId: 'chan-1',
    });
    const passedMessage = runAgentMock.mock.calls[0]?.[1] as string;
    expect(passedMessage).toContain("Relevant context from this channel's memory:");
    expect(passedMessage).toContain('- we deploy with yarn release');
    expect(passedMessage).toContain('User: how do I deploy?');
  });

  it('passes the raw user text when there is no relevant memory', async () => {
    findChannel.mockResolvedValue({
      agentKey: 'channelAssistant',
      monthlyBudgetUsdCents: null,
    } as never);
    retrieveChannelMemoryMock.mockResolvedValue([]);

    await runChannelAssistantTurn(makeInput({ userText: 'hello' }));

    expect(runAgentMock.mock.calls[0]?.[1]).toBe('hello');
  });

  it('writes channel memory after a successful, non-trivial turn', async () => {
    findChannel.mockResolvedValue({
      agentKey: 'channelAssistant',
      monthlyBudgetUsdCents: null,
    } as never);
    runAgentMock.mockResolvedValue({
      costUsd: 0.02,
      text: 'To deploy, run `yarn release` from the repo root after the CI checks pass.',
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await runChannelAssistantTurn(makeInput({ userText: 'how do I deploy?' }));

    expect(writeChannelMemoryMock).toHaveBeenCalledTimes(1);
    const writeArg = writeChannelMemoryMock.mock.calls[0]?.[0] as {
      channelId: string;
      teamId: string;
      orgId: string;
      summary: string;
      rationale: string;
      userSlackId?: string;
    };
    expect(writeArg.channelId).toBe('chan-1');
    expect(writeArg.teamId).toBe('team-1');
    expect(writeArg.orgId).toBe('org-1');
    expect(writeArg.summary).toContain('yarn release');
    expect(writeArg.rationale).toBe('how do I deploy?');
    expect(writeArg.userSlackId).toBe('U999');
  });

  it('does not write memory for a trivial reply', async () => {
    findChannel.mockResolvedValue({
      agentKey: 'channelAssistant',
      monthlyBudgetUsdCents: null,
    } as never);
    // Default runAgent mock replies 'hi there' (< 40 chars) → too trivial to store.
    await runChannelAssistantTurn(makeInput());

    expect(writeChannelMemoryMock).not.toHaveBeenCalled();
  });

  it('still returns the reply when memory write fails (best-effort)', async () => {
    findChannel.mockResolvedValue({
      agentKey: 'channelAssistant',
      monthlyBudgetUsdCents: null,
    } as never);
    runAgentMock.mockResolvedValue({
      costUsd: 0.02,
      text: 'A sufficiently long and helpful reply that should be persisted to memory.',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    writeChannelMemoryMock.mockRejectedValue(new Error('embed down'));

    const result = await runChannelAssistantTurn(makeInput());

    expect(result.reply).toContain('sufficiently long');
  });

  it('does not retrieve or write memory on the budget-skip path', async () => {
    findChannel.mockResolvedValue({
      agentKey: 'channelAssistant',
      monthlyBudgetUsdCents: 500,
    } as never);
    findUsage.mockResolvedValue({ costUsdAccrued: 5 } as never);

    await runChannelAssistantTurn(makeInput());

    expect(retrieveChannelMemoryMock).not.toHaveBeenCalled();
    expect(writeChannelMemoryMock).not.toHaveBeenCalled();
  });
});
