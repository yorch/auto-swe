import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApplicationFailure } from '@temporalio/activity';

// Mock prisma before importing the module under test
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    activeWorkflow: {
      update: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn(),
    },
  },
}));

import { prisma } from '@auto-swe/shared/db';
import { calculateCostUsd, BUDGET_LIMITS, recordLlmUsage } from './costTracking.js';

describe('calculateCostUsd', () => {
  it('computes cost from token counts', () => {
    // 1M input at $15/MTok + 0 output = $15
    expect(calculateCostUsd(1_000_000, 0)).toBeCloseTo(15);
    // 0 input + 1M output at $75/MTok = $75
    expect(calculateCostUsd(0, 1_000_000)).toBeCloseTo(75);
  });
});

describe('BUDGET_LIMITS', () => {
  it('defines three tiers', () => {
    expect(BUDGET_LIMITS.STANDARD.inputTokens).toBe(2_000_000);
    expect(BUDGET_LIMITS.LARGE.inputTokens).toBe(8_000_000);
    expect(BUDGET_LIMITS.EPIC.inputTokens).toBe(20_000_000);
  });
});

describe('recordLlmUsage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates DB and returns when under budget', async () => {
    vi.mocked(prisma.activeWorkflow.findFirst).mockResolvedValue({
      id: 'wf-1',
      budgetTier: 'STANDARD',
      tokensInputUsed: 0,
      tokensOutputUsed: 0,
      costUsdAccrued: 0,
    } as any);
    vi.mocked(prisma.activeWorkflow.update).mockResolvedValue({} as any);

    await expect(
      recordLlmUsage('wf-temporal-1', { inputTokens: 100, outputTokens: 50 })
    ).resolves.not.toThrow();

    expect(prisma.activeWorkflow.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'wf-1' },
        data: expect.objectContaining({ tokensInputUsed: 100, tokensOutputUsed: 50 }),  // DB columns unchanged
      })
    );
  });

  it('returns without error when workflow record is not found', async () => {
    vi.mocked(prisma.activeWorkflow.findFirst).mockResolvedValue(null);

    await expect(
      recordLlmUsage('wf-unknown', { inputTokens: 100, outputTokens: 50 })
    ).resolves.not.toThrow();

    expect(prisma.activeWorkflow.update).not.toHaveBeenCalled();
  });

  it('throws BUDGET_EXCEEDED when cumulative input tokens exceed tier limit', async () => {
    vi.mocked(prisma.activeWorkflow.findFirst).mockResolvedValue({
      id: 'wf-1',
      budgetTier: 'STANDARD',
      tokensInputUsed: 1_999_900,
      tokensOutputUsed: 0,
      costUsdAccrued: 29.99,
    } as any);

    await expect(
      recordLlmUsage('wf-temporal-1', { inputTokens: 200, outputTokens: 10 })
    ).rejects.toThrow(ApplicationFailure);
  });
});
