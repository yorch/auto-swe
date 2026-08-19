import { ApplicationFailure, log } from '@temporalio/activity';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

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
          modelSpec: 'anthropic/claude-opus-4-8',
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

// Mock the workflow-defaults resolver — recordLlmUsage reads its per-tier
// budgets from here (memoized through the shared config cache). Default returns
// the baked-in tier numbers so existing budget tests behave unchanged.
// `assertBudgetAvailable` now derives the workflow id from Temporal activity
// context instead of trusting a caller-supplied string.
vi.mock('./activityContext.js', () => ({
  currentActivityType: () => 'commitToMemory',
  currentWorkflowId: () => 'wf-temporal-1',
}));

// The unregistered-agent check only judges activities the boot gate walked, so
// it needs the gate to have run. `gatedStepNames()` returns null in a bare
// process, which is "cannot judge" — a test asserting the warning has to say
// the step was gated.
const gatedStepsMock = vi.fn<() => Set<string> | null>(() => new Set(['commitToMemory']));
vi.mock('./config/deploymentAgents.js', () => ({
  gatedStepNames: () => gatedStepsMock(),
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: vi.fn(async () => ({
    budgetTiers: {
      EPIC: { inputTokens: 20_000_000, outputTokens: 5_000_000 },
      LARGE: { inputTokens: 8_000_000, outputTokens: 2_000_000 },
      STANDARD: { inputTokens: 2_000_000, outputTokens: 500_000 },
    },
  })),
}));

import { _resetConfigCacheForTests } from '@auto-swe/shared/config/cache';
import { prisma } from '@auto-swe/shared/db';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import {
  assertBudgetAvailable,
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
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
  });

  afterEach(() => warnSpy.mockRestore());

  /**
   * Wire `activeWorkflow.findFirst`/`update` to a tiny in-memory row that
   * applies Prisma's `{ increment }` the way Postgres would. Returning a fixed
   * object instead would make the counters untestable — and would hide the
   * lost-update bug this replaced, since every caller would read the same
   * pre-set totals.
   */
  function ledger(init: {
    budgetTier?: string;
    tokensInputUsed?: number;
    tokensOutputUsed?: number;
    costUsdAccrued?: number;
  }) {
    const row = {
      budgetTier: init.budgetTier ?? 'STANDARD',
      costUsdAccrued: init.costUsdAccrued ?? 0,
      id: 'wf-1',
      tokensInputUsed: init.tokensInputUsed ?? 0,
      tokensOutputUsed: init.tokensOutputUsed ?? 0,
    };
    (prisma.activeWorkflow.findFirst as unknown as Mock).mockImplementation(async () => ({
      ...row,
    }));
    (prisma.activeWorkflow.update as unknown as Mock).mockImplementation(async (args: unknown) => {
      const data = (args as { data: Record<string, { increment?: number }> }).data;
      for (const [field, op] of Object.entries(data)) {
        if (typeof op?.increment === 'number') {
          (row as Record<string, unknown>)[field] =
            (row[field as keyof typeof row] as number) + op.increment;
        }
      }
      return { ...row };
    });
    return row;
  }

  it('updates DB and returns when under budget', async () => {
    const row = ledger({});

    await expect(
      recordLlmUsage('wf-temporal-1', 'implementer', { inputTokens: 100, outputTokens: 50 })
    ).resolves.not.toThrow();

    expect(prisma.activeWorkflow.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tokensInputUsed: { increment: 100 },
          tokensOutputUsed: { increment: 50 },
        }),
        where: { temporalWorkflowId: 'wf-temporal-1' },
      })
    );
    expect(row.tokensInputUsed).toBe(100);
    expect(row.tokensOutputUsed).toBe(50);
  });

  it('does not lose usage when calls run concurrently', async () => {
    // The review network fires three reviewers under one Promise.allSettled and
    // fanOut branches run in parallel, so read-modify-write dropped increments
    // exactly when spend was highest.
    const row = ledger({});

    await Promise.all(
      Array.from({ length: 3 }, () =>
        recordLlmUsage('wf-temporal-1', 'implementer', { inputTokens: 100, outputTokens: 50 })
      )
    );

    expect(row.tokensInputUsed).toBe(300);
    expect(row.tokensOutputUsed).toBe(150);
  });

  it('checks the budget against the post-increment total, not its own read', async () => {
    // Under concurrency the value this call read may already be stale; the
    // authoritative total is what the increment returned.
    ledger({ tokensInputUsed: 1_999_950 });

    await expect(
      recordLlmUsage('wf-temporal-1', 'implementer', { inputTokens: 100, outputTokens: 1 })
    ).rejects.toThrow(/Budget exceeded/);
  });

  it('does not gate a workflow that is still under its tier', async () => {
    ledger({ tokensInputUsed: 10 });
    await expect(assertBudgetAvailable('implementer')).resolves.toBeUndefined();
  });

  it('refuses a call once the tier is already spent', async () => {
    ledger({ tokensInputUsed: 2_000_000 });

    await expect(assertBudgetAvailable('implementer')).rejects.toThrow(/Budget already exhausted/);
  });

  it('gates on the output ceiling too, not just input', async () => {
    ledger({ tokensOutputUsed: 500_000 });
    await expect(assertBudgetAvailable('implementer')).rejects.toThrow(/Budget already exhausted/);
  });

  it('never spends when the gate fires', async () => {
    // The whole point: with three reviewers in flight, the ones that have not
    // called the provider yet must not each burn a call before their own
    // post-check fires.
    ledger({ tokensInputUsed: 2_000_000 });

    await expect(assertBudgetAvailable('review.security')).rejects.toThrow();
    expect(prisma.activeWorkflow.update).not.toHaveBeenCalled();
  });

  it('no-ops for a run with no ActiveWorkflow ledger row', async () => {
    // Channel tasks and PRD runs have none; they must not be blocked.
    (prisma.activeWorkflow.findFirst as unknown as Mock).mockResolvedValue(null);
    await expect(assertBudgetAvailable('x')).resolves.toBeUndefined();
  });

  it('returns without error when workflow record is not found', async () => {
    (prisma.activeWorkflow.findFirst as unknown as Mock).mockResolvedValue(null);
    // Prisma's `update` on a missing row raises P2025; the usage call swallows
    // exactly that code and nothing else.
    (prisma.activeWorkflow.update as unknown as Mock).mockRejectedValue(
      Object.assign(new Error('Record to update not found'), { code: 'P2025' })
    );

    await expect(
      recordLlmUsage('wf-unknown', 'implementer', { inputTokens: 100, outputTokens: 50 })
    ).resolves.not.toThrow();
  });

  it('rethrows a non-P2025 update failure rather than silently losing usage', async () => {
    (prisma.activeWorkflow.update as unknown as Mock).mockRejectedValue(
      Object.assign(new Error('deadlock detected'), { code: 'P2034' })
    );

    await expect(
      recordLlmUsage('wf-temporal-1', 'implementer', { inputTokens: 100, outputTokens: 50 })
    ).rejects.toThrow('deadlock detected');
  });

  it('flags a step that spends on an agent the boot gate does not know about', async () => {
    ledger({});
    // `commitToMemory` is a registered step, but not for the `planner` key. The
    // role is deliberately one no earlier test in this file used: the warning is
    // once per (step, agent) per process, so a shared pair would already be spent.
    await recordLlmUsage('wf-temporal-1', 'planner', { inputTokens: 1, outputTokens: 1 });

    // Advisory, never fatal — the provider has already been paid.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('STEP_REQUIRED_AGENTS'),
      expect.objectContaining({ role: 'planner' })
    );

    // A drifted entry on a hot step would otherwise repeat this line on every
    // single call and bury itself.
    warnSpy.mockClear();
    await recordLlmUsage('wf-temporal-1', 'planner', { inputTokens: 1, outputTokens: 1 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('stays quiet when the step declares the agent it used', async () => {
    ledger({});
    await recordLlmUsage('wf-temporal-1', 'commitToMemory', { inputTokens: 1, outputTokens: 1 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('stays quiet for an activity the boot gate never walked', async () => {
    // Most LLM-spending activities are not step executors — channel turns, the
    // memory passes, the workflow-authoring activities — and `assertConfigReady`
    // covers those by other rules. Judging them against a map of *steps* would
    // warn on every healthy deployment, which is how an advisory signal becomes
    // noise nobody reads.
    ledger({});
    gatedStepsMock.mockReturnValueOnce(new Set(['executeImplementation']));
    await recordLlmUsage('wf-temporal-1', 'evalJudge', { inputTokens: 1, outputTokens: 1 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('stays quiet when the boot gate has not run in this process', async () => {
    // No gate means no basis to judge; guessing would warn on every direct
    // activity call and every unit test that reaches the ledger.
    ledger({});
    gatedStepsMock.mockReturnValueOnce(null);
    await recordLlmUsage('wf-temporal-1', 'securityReview', { inputTokens: 1, outputTokens: 1 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('accrues in a single query, keyed on the unique temporalWorkflowId', async () => {
    ledger({});
    await recordLlmUsage('wf-temporal-1', 'implementer', { inputTokens: 1, outputTokens: 1 });
    // The hottest path in the worker; a read-then-write would double its round trips.
    expect(prisma.activeWorkflow.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { temporalWorkflowId: 'wf-temporal-1' } })
    );
  });

  it('enforces the per-tier budget resolved from workflow defaults (tiny override fires BUDGET_EXCEEDED early)', async () => {
    // A tiny STANDARD cap from the resolver must gate a call that would sail
    // through the baked-in 2M-token default — proving the resolved value, not
    // BUDGET_LIMITS, drives enforcement.
    vi.mocked(resolveWorkflowDefaults).mockResolvedValueOnce({
      budgetTiers: {
        EPIC: { inputTokens: 20_000_000, outputTokens: 5_000_000 },
        LARGE: { inputTokens: 8_000_000, outputTokens: 2_000_000 },
        STANDARD: { inputTokens: 100, outputTokens: 100 },
      },
    } as never);
    vi.mocked(prisma.activeWorkflow.findFirst).mockResolvedValue({
      budgetTier: 'STANDARD',
      costUsdAccrued: 0,
      id: 'wf-1',
      tokensInputUsed: 0,
      tokensOutputUsed: 0,
    } as never);

    await expect(
      recordLlmUsage('wf-temporal-1', 'implementer', { inputTokens: 200, outputTokens: 10 })
    ).rejects.toThrow(ApplicationFailure);
  });

  it('throws BUDGET_EXCEEDED when cumulative input tokens exceed tier limit', async () => {
    ledger({ costUsdAccrued: 29.99, tokensInputUsed: 1_999_900 });

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
    ledger({});

    await recordLlmUsage('wf-temporal-1', 'implementer', { inputTokens: 1000, outputTokens: 500 });

    expect(prisma.activeWorkflow.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          costUsdAccrued: { increment: 0 },
          tokensInputUsed: { increment: 1000 },
          tokensOutputUsed: { increment: 500 },
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
    ledger({});

    // Must NOT reject — the workflow.update must still happen.
    await recordLlmUsage('wf-temporal-1', 'implementer', {
      inputTokens: 100_000,
      outputTokens: 50_000,
    });

    expect(prisma.activeWorkflow.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          // Zero cost — unknown/unknown spec falls through to ZERO_PRICE.
          costUsdAccrued: { increment: 0 },
          tokensInputUsed: { increment: 100_000 },
          tokensOutputUsed: { increment: 50_000 },
        }),
      })
    );
  });
});
