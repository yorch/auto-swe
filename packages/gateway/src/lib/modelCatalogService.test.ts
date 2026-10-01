import type { PrismaClient } from '@auto-swe/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  catalogWarnings,
  findUnpricedSpecs,
  suggestSpec,
  UNPRICED_TRACE_LOOKBACK_DAYS,
} from './modelCatalogService.js';

interface CatalogRow {
  provider: string;
  modelId: string;
  kind: 'CHAT' | 'EMBEDDING';
  status: 'ACTIVE' | 'DEPRECATED' | 'RETIRED';
}

function fakePrisma(
  opts: {
    catalog?: CatalogRow[];
    agents?: Array<{ key: string; modelSpec: string | null }>;
    embeddingSpec?: string | null;
    traceModels?: string[];
  } = {}
) {
  const catalog = opts.catalog ?? [];
  const agentTraceFindMany = vi.fn(async () =>
    (opts.traceModels ?? []).map((model) => ({ model }))
  );
  const prisma = {
    agent: { findMany: vi.fn(async () => opts.agents ?? []) },
    agentTrace: { findMany: agentTraceFindMany },
    embeddingConfig: {
      findUnique: vi.fn(async () =>
        opts.embeddingSpec ? { modelSpec: opts.embeddingSpec } : null
      ),
    },
    modelCatalogEntry: {
      findMany: vi.fn(async () => catalog.map(({ provider, modelId }) => ({ modelId, provider }))),
      findUnique: vi.fn(
        async ({ where }: { where: { provider_modelId: { provider: string; modelId: string } } }) =>
          catalog.find(
            (r) =>
              r.provider === where.provider_modelId.provider &&
              r.modelId === where.provider_modelId.modelId
          ) ?? null
      ),
    },
  };
  return { agentTraceFindMany, prisma: prisma as unknown as PrismaClient };
}

describe('suggestSpec', () => {
  const priced = ['openai/gpt-5.5', 'openai/gpt-5.5-pro', 'anthropic/claude-opus-5-5'];

  it('matches a spelling that differs only by "." vs "-"', () => {
    expect(suggestSpec('openai/gpt-5-5', priced)).toBe('openai/gpt-5.5');
    expect(suggestSpec('anthropic/claude-opus-5.5', priced)).toBe('anthropic/claude-opus-5-5');
  });

  it('falls back to the single nearest spec from the same provider', () => {
    expect(suggestSpec('anthropic/claude-opus-5-55', priced)).toBe('anthropic/claude-opus-5-5');
  });

  it('suggests nothing across providers, when too far, or when two are equally near', () => {
    expect(suggestSpec('google/gpt-5.5', priced)).toBeNull();
    expect(suggestSpec('openai/gpt-7-ultra', priced)).toBeNull();
    expect(suggestSpec('x/ab', ['x/aa', 'x/bb'])).toBeNull();
  });
});

describe('catalogWarnings', () => {
  it('is silent for a cataloged, active model of the right kind', async () => {
    const { prisma } = fakePrisma({
      catalog: [
        { kind: 'CHAT', modelId: 'claude-opus-5-5', provider: 'anthropic', status: 'ACTIVE' },
      ],
    });
    expect(await catalogWarnings(prisma, 'anthropic/claude-opus-5-5', 'CHAT')).toEqual([]);
  });

  it('is silent for a built-in model the catalog has not been seeded with yet', async () => {
    // The worker prices it from BUILTIN_MODELS, so it is not unpriced.
    const { prisma } = fakePrisma();
    expect(await catalogWarnings(prisma, 'anthropic/claude-opus-5-5', 'CHAT')).toEqual([]);
  });

  it('warns that an unknown spec is recorded at $0, with a did-you-mean', async () => {
    const { prisma } = fakePrisma();
    const [warning] = await catalogWarnings(prisma, 'openai/gpt-5-5', 'CHAT');
    expect(warning).toContain('recorded at $0');
    expect(warning).toContain("Did you mean 'openai/gpt-5.5'?");
  });

  it('warns on the wrong kind, and on a deprecated or retired model', async () => {
    const { prisma } = fakePrisma({
      catalog: [
        { kind: 'CHAT', modelId: 'old-chat', provider: 'openai', status: 'DEPRECATED' },
        { kind: 'CHAT', modelId: 'gone', provider: 'openai', status: 'RETIRED' },
      ],
    });
    const deprecated = await catalogWarnings(prisma, 'openai/old-chat', 'EMBEDDING');
    expect(deprecated).toHaveLength(2);
    expect(deprecated[0]).toContain('cataloged as a chat model');
    expect(deprecated[1]).toContain('deprecated');
    expect(await catalogWarnings(prisma, 'openai/gone', 'CHAT')).toEqual([
      "'openai/gone' is retired in the model catalog; its provider may no longer serve it.",
    ]);
  });
});

describe('findUnpricedSpecs', () => {
  it('unions agents, the embedding config and recent calls, minus everything priced', async () => {
    const { prisma, agentTraceFindMany } = fakePrisma({
      agents: [
        { key: 'implementer', modelSpec: 'anthropic/claude-opus-5-5' }, // built-in: priced
        { key: 'reviewer', modelSpec: 'openai/gpt-5-5' },
        { key: 'planner', modelSpec: 'openai/gpt-5-5' },
        { key: 'local', modelSpec: 'ollama/llama-4' }, // cataloged: priced
      ],
      catalog: [{ kind: 'CHAT', modelId: 'llama-4', provider: 'ollama', status: 'ACTIVE' }],
      embeddingSpec: 'acme/embed-1',
      traceModels: ['openai/gpt-5-5', 'mystery/model'],
    });
    const now = new Date('2026-10-01T00:00:00Z');
    expect(await findUnpricedSpecs(prisma, now)).toEqual([
      { spec: 'acme/embed-1', suggestion: null, usedBy: ['embedding-config'] },
      { spec: 'mystery/model', suggestion: null, usedBy: ['recent-calls'] },
      {
        spec: 'openai/gpt-5-5',
        suggestion: 'openai/gpt-5.5',
        usedBy: ['agent:planner', 'agent:reviewer', 'recent-calls'],
      },
    ]);
    const where = (agentTraceFindMany.mock.calls[0] as unknown as [{ where: unknown }])[0].where;
    expect(where).toMatchObject({
      createdAt: { gte: new Date(now.getTime() - UNPRICED_TRACE_LOOKBACK_DAYS * 86_400_000) },
      type: 'llm_response',
    });
  });
});
