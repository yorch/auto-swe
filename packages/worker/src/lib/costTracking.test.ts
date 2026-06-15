import { ApplicationFailure } from '@temporalio/activity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock prisma before importing the module under test. modelRoleConfig +
// providerCredential return a healthy GLOBAL row + credential so
// recordLlmUsage's getModelSpec call resolves cleanly.
//
// Using an ASYNC factory + `await import()` so the alias map in
// vitest.config.ts resolves `@auto-swe/shared/lib/crypto` to the .ts
// source — synchronous `require()` would resolve via Node and demand a
// built `dist/`, which CI doesn't produce before running the test job.
vi.mock('@auto-swe/shared/db', async () => {
  const { randomBytes } = await import('node:crypto');
  if (!process.env.CONFIG_ENCRYPTION_KEY) {
    process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  }
  const { encryptSecret } = await import('@auto-swe/shared/lib/crypto');
  const sealed = encryptSecret('sk-test-fixture');
  return {
    prisma: {
      activeWorkflow: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
      agent: {
        findFirst: vi.fn().mockResolvedValue({
          inheritsModelFrom: null,
          isVerified: true,
          key: 'implementer',
          modelSpec: 'anthropic/claude-opus-4-7',
          origin: null,
          scope: 'GLOBAL',
          skillRefs: [],
          systemPrompt: null,
          toolKeys: null,
          version: 1,
        }),
      },
      embeddingConfig: { findUnique: vi.fn() },
      providerCredential: {
        findFirst: vi.fn().mockResolvedValue({
          apiBase: null,
          apiKeyAuthTag: sealed.authTag,
          apiKeyCiphertext: sealed.ciphertext,
          apiKeyNonce: sealed.nonce,
          keyVersion: sealed.keyVersion,
        }),
      },
    },
  };
});

import { prisma } from '@auto-swe/shared/db';
import { _resetConfigCacheForTests } from './config/cache.js';
import {
  BUDGET_LIMITS,
  calculateCostUsd,
  getModelPrice,
  MODEL_PRICES,
  recordLlmUsage,
} from './costTracking.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  // Drop resolved-config cache so each test's mock overrides take effect
  // instead of being shadowed by the previous test's resolution.
  _resetConfigCacheForTests();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('getModelPrice', () => {
  it('returns the static price for a known spec', () => {
    const r = getModelPrice('anthropic/claude-opus-4-6');
    expect(r.known).toBe(true);
    expect(r.price).toEqual({ input: 5, output: 25 });
  });

  it('returns zero with known=false for unknown specs', () => {
    const r = getModelPrice('mystery/unreleased-model');
    expect(r.known).toBe(false);
    expect(r.price).toEqual({ input: 0, output: 0 });
  });

  it('honours per-model env overrides', () => {
    process.env.MODEL_PRICE_OPENAI_GPT_5 = '7:25';
    const r = getModelPrice('openai/gpt-5');
    expect(r.known).toBe(true);
    expect(r.price).toEqual({ input: 7, output: 25 });
  });

  it('ignores malformed env overrides and falls back to the table or zero', () => {
    process.env.MODEL_PRICE_ANTHROPIC_CLAUDE_OPUS_4_6 = 'not:numbers';
    const r = getModelPrice('anthropic/claude-opus-4-6');
    expect(r.price).toEqual(MODEL_PRICES['anthropic/claude-opus-4-6']);
  });

  it('ignores negative price overrides — they could bypass budget enforcement', () => {
    process.env.MODEL_PRICE_ANTHROPIC_CLAUDE_OPUS_4_6 = '-5:-25';
    const r = getModelPrice('anthropic/claude-opus-4-6');
    expect(r.price).toEqual(MODEL_PRICES['anthropic/claude-opus-4-6']);
  });

  it('ignores overrides that have the wrong number of fields', () => {
    process.env.MODEL_PRICE_ANTHROPIC_CLAUDE_OPUS_4_6 = '5';
    const r = getModelPrice('anthropic/claude-opus-4-6');
    expect(r.price).toEqual(MODEL_PRICES['anthropic/claude-opus-4-6']);
  });

  it('accepts zero in either field of a price override', () => {
    process.env.MODEL_PRICE_LOCAL_OLLAMA = '0:0';
    const r = getModelPrice('local/ollama');
    expect(r.known).toBe(true);
    expect(r.price).toEqual({ input: 0, output: 0 });
  });
});

describe('calculateCostUsd', () => {
  it('prices a known model', () => {
    // Opus 4.6: $5 in / $25 out per MTok → 1M in + 0 out = $5
    expect(calculateCostUsd('anthropic/claude-opus-4-6', 1_000_000, 0)).toBeCloseTo(5);
    expect(calculateCostUsd('anthropic/claude-opus-4-6', 0, 1_000_000)).toBeCloseTo(25);
  });

  it('returns 0 for unknown models', () => {
    expect(calculateCostUsd('mystery/foo', 1_000_000, 1_000_000)).toBe(0);
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
      budgetTier: 'STANDARD',
      costUsdAccrued: 0,
      id: 'wf-1',
      tokensInputUsed: 0,
      tokensOutputUsed: 0,
    } as never);
    vi.mocked(prisma.activeWorkflow.update).mockResolvedValue({} as never);

    await expect(
      recordLlmUsage('wf-temporal-1', 'implementer', { inputTokens: 100, outputTokens: 50 })
    ).resolves.not.toThrow();

    expect(prisma.activeWorkflow.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tokensInputUsed: 100, tokensOutputUsed: 50 }), // DB columns unchanged
        where: { id: 'wf-1' },
      })
    );
  });

  it('returns without error when workflow record is not found', async () => {
    vi.mocked(prisma.activeWorkflow.findFirst).mockResolvedValue(null);

    await expect(
      recordLlmUsage('wf-unknown', 'implementer', { inputTokens: 100, outputTokens: 50 })
    ).resolves.not.toThrow();

    expect(prisma.activeWorkflow.update).not.toHaveBeenCalled();
  });

  it('throws BUDGET_EXCEEDED when cumulative input tokens exceed tier limit', async () => {
    vi.mocked(prisma.activeWorkflow.findFirst).mockResolvedValue({
      budgetTier: 'STANDARD',
      costUsdAccrued: 29.99,
      id: 'wf-1',
      tokensInputUsed: 1_999_900,
      tokensOutputUsed: 0,
    } as never);

    await expect(
      recordLlmUsage('wf-temporal-1', 'implementer', { inputTokens: 200, outputTokens: 10 })
    ).rejects.toThrow(ApplicationFailure);
  });

  it('still records usage for unknown models, just at zero cost', async () => {
    // Swap the GLOBAL Agent's spec to a model not in MODEL_PRICES.
    vi.mocked(prisma.agent.findFirst).mockResolvedValueOnce({
      inheritsModelFrom: null,
      key: 'implementer',
      modelSpec: 'mystery/unreleased',
      scope: 'GLOBAL',
      skillRefs: [],
      systemPrompt: null,
      toolKeys: null,
      version: 1,
    } as never);
    vi.mocked(prisma.activeWorkflow.findFirst).mockResolvedValue({
      budgetTier: 'STANDARD',
      costUsdAccrued: 0,
      id: 'wf-1',
      tokensInputUsed: 0,
      tokensOutputUsed: 0,
    } as never);

    await recordLlmUsage('wf-temporal-1', 'implementer', { inputTokens: 1000, outputTokens: 500 });

    expect(prisma.activeWorkflow.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          costUsdAccrued: 0,
          tokensInputUsed: 1000,
          tokensOutputUsed: 500,
        }),
      })
    );
  });

  it('still debits token counters when getModelSpec rejects (malformed DB row)', async () => {
    // The GLOBAL row has a corrupt modelSpec — parseProviderModelSpec throws
    // inside resolveModelConfig. Without the defensive try/catch, tokens
    // already spent at the upstream LLM would never get debited and
    // BUDGET_EXCEEDED would never fire — Temporal retries would re-spend
    // tokens indefinitely.
    vi.mocked(prisma.agent.findFirst).mockResolvedValueOnce({
      inheritsModelFrom: null,
      key: 'implementer',
      modelSpec: 'broken-no-slash',
      scope: 'GLOBAL',
      skillRefs: [],
      systemPrompt: null,
      toolKeys: null,
      version: 1,
    } as never);
    vi.mocked(prisma.activeWorkflow.findFirst).mockResolvedValue({
      budgetTier: 'STANDARD',
      costUsdAccrued: 0,
      id: 'wf-1',
      tokensInputUsed: 0,
      tokensOutputUsed: 0,
    } as never);

    // Must NOT reject — the workflow.update must still happen.
    await recordLlmUsage('wf-temporal-1', 'implementer', {
      inputTokens: 100_000,
      outputTokens: 50_000,
    });

    expect(prisma.activeWorkflow.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          // Zero cost — unknown/unknown spec falls through to ZERO_PRICE.
          costUsdAccrued: 0,
          tokensInputUsed: 100_000,
          tokensOutputUsed: 50_000,
        }),
      })
    );
  });
});
