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

// Real cost-tracking math (calculateCostUsd) — no DB or env needed for the
// table lookup, so we exercise the genuine pricing path.

import { prisma } from '@auto-swe/shared/db';
import type { ChannelAssistantTurnInput } from '@auto-swe/shared/types/workflow';
import { isChannelOverBudget, runChannelAssistantTurn } from './channelAssistant.js';

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
    text: 'hi there',
    usage: { inputTokens: 1000, outputTokens: 500 },
  });
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
    // opus-4-8: $5/MTok in, $25/MTok out → 1000*5/1e6 + 500*25/1e6 = 0.005 + 0.0125
    expect(args.create.costUsdAccrued).toBeCloseTo(0.0175, 6);
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
});
