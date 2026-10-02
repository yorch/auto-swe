import { ApplicationFailure, asyncLocalStorage, log } from '@temporalio/activity';
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
      // Empty by default: pricing falls through to the built-in table.
      modelCatalogEntry: { findMany: vi.fn().mockResolvedValue([]) },
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
  _resetModelPricesForTests,
  assertBudgetAvailable,
  BUDGET_LIMITS,
  calculateCostUsd,
  getModelPrice,
  ignoredPriceOverrideVars,
  MODEL_PRICES,
  recordLlmUsage,
} from './costTracking.js';

const catalogFindMany = prisma.modelCatalogEntry.findMany as unknown as Mock;

/** A catalog row as `findMany` returns it, for the fields pricing selects. */
/** Runs `fn` inside a stand-in activity context whose logger records warnings. */
async function inActivity<T>(fn: () => Promise<T>): Promise<{ result: T; warn: Mock }> {
  const warn = vi.fn();
  const context = { log: { error: vi.fn(), warn } } as unknown as Parameters<
    typeof asyncLocalStorage.run
  >[0];
  const result = await asyncLocalStorage.run(context, fn);
  return { result, warn };
}

function catalogRow(spec: string, input: number, output: number) {
  const [provider, ...rest] = spec.split('/');
  return { inputUsdPerMTok: input, modelId: rest.join('/'), outputUsdPerMTok: output, provider };
}

const originalEnv = { ...process.env };

beforeEach(() => {
  // Drop resolved-config cache so each test's mock overrides take effect
  // instead of being shadowed by the previous test's resolution.
  _resetConfigCacheForTests();
  _resetModelPricesForTests();
  catalogFindMany.mockReset();
  catalogFindMany.mockResolvedValue([]);
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('getModelPrice', () => {
  it('prices a built-in model from the built-in table when the catalog has no row', async () => {
    expect(await getModelPrice('anthropic/claude-opus-4-6')).toEqual({
      known: true,
      price: { input: 5, output: 25 },
      source: 'builtin',
    });
  });

  it('prices from the catalog first — an admin edit beats the built-in price', async () => {
    catalogFindMany.mockResolvedValue([catalogRow('anthropic/claude-opus-4-6', 1, 2)]);
    expect(await getModelPrice('anthropic/claude-opus-4-6')).toEqual({
      known: true,
      price: { input: 1, output: 2 },
      source: 'catalog',
    });
  });

  it('prices a model only the catalog knows, and treats a 0/0 row as known and free', async () => {
    catalogFindMany.mockResolvedValue([
      catalogRow('openrouter/anthropic/claude-opus-5-5', 4.4, 22),
      catalogRow('ollama/llama-4', 0, 0),
    ]);
    expect(await getModelPrice('openrouter/anthropic/claude-opus-5-5')).toMatchObject({
      known: true,
      price: { input: 4.4, output: 22 },
    });
    expect(await getModelPrice('ollama/llama-4')).toEqual({
      known: true,
      price: { input: 0, output: 0 },
      source: 'catalog',
    });
  });

  it('skips a catalog row with a negative or non-finite price — it could bypass budget enforcement', async () => {
    catalogFindMany.mockResolvedValue([
      catalogRow('anthropic/claude-opus-4-6', -5, -25),
      catalogRow('ollama/llama-4', Number.NaN, 0),
    ]);
    expect(await getModelPrice('anthropic/claude-opus-4-6')).toMatchObject({
      price: MODEL_PRICES['anthropic/claude-opus-4-6'],
      source: 'builtin',
    });
    expect((await getModelPrice('ollama/llama-4')).known).toBe(false);
  });

  it('keys OpenAI models by their dotted IDs, the form the OpenAI API serves', async () => {
    expect(await getModelPrice('openai/gpt-5.5')).toMatchObject({
      known: true,
      price: { input: 5, output: 30 },
    });
    expect(await getModelPrice('openai/gpt-5.5-pro')).toMatchObject({
      known: true,
      price: { input: 30, output: 180 },
    });
    // The dashed form is not a real OpenAI ID; pricing it would hide a broken spec.
    expect((await getModelPrice('openai/gpt-5-5')).known).toBe(false);
  });

  it('returns zero with known=false for unknown specs', async () => {
    expect(await getModelPrice('mystery/unreleased-model')).toEqual({
      known: false,
      price: { input: 0, output: 0 },
      source: 'unknown',
    });
  });

  it('reads the catalog once per cache window, not once per call', async () => {
    await getModelPrice('anthropic/claude-opus-4-6');
    await getModelPrice('openai/gpt-5.5');
    expect(catalogFindMany).toHaveBeenCalledTimes(1);
  });

  it('never throws when the catalog is unreadable, and prices from the built-in table', async () => {
    catalogFindMany.mockRejectedValue(new Error('connection refused'));
    const { result, warn } = await inActivity(() => getModelPrice('anthropic/claude-opus-4-6'));
    expect(result).toMatchObject({
      price: MODEL_PRICES['anthropic/claude-opus-4-6'],
      source: 'builtin',
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never throws outside an activity, where the Temporal logger itself throws', async () => {
    // Embedding usage is priced outside an activity too (scripts, tests).
    catalogFindMany.mockRejectedValue(new Error('connection refused'));
    expect(asyncLocalStorage.getStore()).toBeUndefined();
    await expect(getModelPrice('anthropic/claude-opus-4-6')).resolves.toMatchObject({
      source: 'builtin',
    });
  });

  it('keeps pricing from the last catalog it read while the catalog is unreadable', async () => {
    catalogFindMany.mockResolvedValueOnce([catalogRow('anthropic/claude-opus-4-6', 1, 2)]);
    await getModelPrice('anthropic/claude-opus-4-6');
    _resetConfigCacheForTests(); // the cached read expires
    catalogFindMany.mockRejectedValue(new Error('connection refused'));
    expect(await getModelPrice('anthropic/claude-opus-4-6')).toEqual({
      known: true,
      price: { input: 1, output: 2 },
      source: 'catalog',
    });
  });

  it('backs off after a failed read instead of querying and warning on every call', async () => {
    catalogFindMany.mockRejectedValue(new Error('connection refused'));
    const { warn } = await inActivity(async () => {
      await getModelPrice('anthropic/claude-opus-4-6');
      await getModelPrice('anthropic/claude-opus-4-6');
      await getModelPrice('openai/gpt-5.5');
    });
    expect(catalogFindMany).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('no longer reads MODEL_PRICE_* environment overrides', async () => {
    process.env.MODEL_PRICE_OPENAI_GPT_5 = '7:25';
    expect((await getModelPrice('openai/gpt-5')).price).toEqual(MODEL_PRICES['openai/gpt-5']);
  });
});

describe('ignoredPriceOverrideVars', () => {
  it('names every MODEL_PRICE_* variable set, so the worker can warn they are ignored', () => {
    expect(
      ignoredPriceOverrideVars({
        HOME: '/root',
        MODEL_PRICE_ANTHROPIC_CLAUDE_OPUS_5_5: '4:20',
        MODEL_PRICE_OLLAMA_LLAMA3: '0:0',
      })
    ).toEqual(['MODEL_PRICE_ANTHROPIC_CLAUDE_OPUS_5_5', 'MODEL_PRICE_OLLAMA_LLAMA3']);
    expect(ignoredPriceOverrideVars({ HOME: '/root' })).toEqual([]);
  });
});

describe('calculateCostUsd', () => {
  it('prices a known model', async () => {
    // Opus 4.6: $5 in / $25 out per MTok → 1M in + 0 out = $5
    expect(await calculateCostUsd('anthropic/claude-opus-4-6', 1_000_000, 0)).toBeCloseTo(5);
    expect(await calculateCostUsd('anthropic/claude-opus-4-6', 0, 1_000_000)).toBeCloseTo(25);
  });

  it('returns 0 for unknown models', async () => {
    expect(await calculateCostUsd('mystery/foo', 1_000_000, 1_000_000)).toBe(0);
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

  describe('with a bound model spec', () => {
    // The mocked GLOBAL `implementer` Agent resolves to anthropic/claude-opus-4-8; the
    // caller bound a different model (a CHANNEL override, an owning-team override the
    // run chose not to use, or an explicit key@version pin).
    const bound = 'anthropic/claude-haiku-4-5-20251001';
    const usage = { inputTokens: 100_000, outputTokens: 100_000 };

    it('prices at the bound model, not the model the ambient context resolves', async () => {
      ledger({});
      const priced = await recordLlmUsage(
        'wf-temporal-1',
        'implementer',
        usage,
        'llm.usage',
        bound
      );
      expect(priced.modelSpec).toBe(bound);
      expect(priced.costUsd).toBeCloseTo(await calculateCostUsd(bound, 100_000, 100_000), 6);
    });

    it('prices a call with no ledger row at the bound model too', async () => {
      (prisma.activeWorkflow.update as unknown as Mock).mockRejectedValue(
        Object.assign(new Error('none'), { code: 'P2025' })
      );
      const priced = await recordLlmUsage('chan-turn', 'implementer', usage, 'llm.usage', bound);
      expect(priced.modelSpec).toBe(bound);
      expect(priced.costUsd).toBeCloseTo(await calculateCostUsd(bound, 100_000, 100_000), 6);
    });

    it('still re-resolves from the role when no spec is passed', async () => {
      ledger({});
      const priced = await recordLlmUsage('wf-temporal-1', 'implementer', usage);
      expect(priced.modelSpec).toBe('anthropic/claude-opus-4-8');
    });
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
