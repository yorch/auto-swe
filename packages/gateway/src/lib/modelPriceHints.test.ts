import type { PrismaClient } from '@auto-swe/shared';
import type { ProviderListing } from '@auto-swe/shared/lib/modelDiscovery';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async () => []),
}));

import { findPriceHints, resetPriceHintCaches } from './modelPriceHints.js';

const prisma = {} as PrismaClient;
const LIST_URL = 'https://prices.example.com/model_prices.json';

const TABLE = {
  'claude-x-1': {
    cache_creation_input_token_cost: 0.00000375,
    cache_creation_input_token_cost_above_1hr: 0.000006,
    cache_read_input_token_cost: 0.0000003,
    input_cost_per_token: 0.000003,
    litellm_provider: 'anthropic',
    mode: 'chat',
    output_cost_per_token: 0.000015,
  },
  'gemini/gemini-x-pro': {
    input_cost_per_token: 0.00000125,
    litellm_provider: 'gemini',
    mode: 'chat',
    output_cost_per_token: 0.00001,
  },
  'gpt-x': {
    input_cost_per_token: 0.0000025,
    litellm_provider: 'azure',
    mode: 'chat',
    output_cost_per_token: 0.00001,
  },
  'openai/text-embed-x': {
    input_cost_per_token: 0.00000002,
    litellm_provider: 'openai',
    mode: 'embedding',
  },
  sample_spec: { input_cost_per_token: 0, litellm_provider: 'one of litellm_provider' },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

afterEach(() => {
  resetPriceHintCaches();
});

describe('findPriceHints', () => {
  const listing = (models: Array<Record<string, unknown>>): ProviderListing => ({
    complete: true,
    listedIds: new Set(models.map((m) => m.modelId as string)),
    models: models.map((m) => ({ displayName: null, kind: 'CHAT', ...m })) as never,
    ok: true,
  });

  it("puts the provider's own listed price first, then the price list's", async () => {
    const table = {
      'openrouter/anthropic/claude-x': {
        input_cost_per_token: 0.000003,
        litellm_provider: 'openrouter',
        mode: 'chat',
        output_cost_per_token: 0.000015,
      },
    };
    const fetcher = vi.fn(async () => jsonResponse(table));
    const result = await findPriceHints(prisma, 'openrouter', 'anthropic/claude-x', {
      fetcher: fetcher as never,
      listProvider: async () =>
        listing([
          {
            listedPrice: { inputUsdPerMTok: 3.1, outputUsdPerMTok: 15.5 },
            modelId: 'anthropic/claude-x',
          },
        ]),
      priceListUrl: async () => LIST_URL,
    });
    expect(result.unavailable).toEqual([]);
    expect(result.hints).toEqual([
      {
        inputUsdPerMTok: 3.1,
        matchedId: 'anthropic/claude-x',
        outputUsdPerMTok: 15.5,
        source: 'provider',
      },
      expect.objectContaining({
        inputUsdPerMTok: 3,
        matchedId: 'openrouter/anthropic/claude-x',
        source: 'priceList',
        url: LIST_URL,
      }),
    ]);
    // Redirects are refused: the guard checked this URL, not where it would lead.
    expect(fetcher).toHaveBeenCalledWith(LIST_URL, expect.objectContaining({ redirect: 'error' }));
  });

  it('never asks a built-in provider, whose listing states no price', async () => {
    const listProvider = vi.fn();
    const result = await findPriceHints(prisma, 'anthropic', 'claude-x-1', {
      fetcher: (async () => jsonResponse(TABLE)) as never,
      listProvider,
      priceListUrl: async () => LIST_URL,
    });
    expect(listProvider).not.toHaveBeenCalled();
    expect(result.hints).toEqual([expect.objectContaining({ source: 'priceList' })]);
  });

  it('fetches nothing when the price list is turned off', async () => {
    const fetcher = vi.fn();
    const result = await findPriceHints(prisma, 'anthropic', 'claude-x-1', {
      fetcher: fetcher as never,
      priceListUrl: async () => '',
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result).toEqual({ hints: [], unavailable: [] });
  });

  it('reports a failing source by a fixed string, never its error text', async () => {
    const result = await findPriceHints(prisma, 'openrouter', 'm', {
      fetcher: (async () => {
        throw new Error('connect ECONNREFUSED https://user:secret@prices.example.com');
      }) as never,
      listProvider: async () => ({ error: 'HTTP 401', ok: false }),
      priceListUrl: async () => LIST_URL,
    });
    expect(result.hints).toEqual([]);
    expect(result.unavailable).toEqual([
      { reason: 'HTTP 401', source: 'provider' },
      { reason: 'request failed (Error)', source: 'priceList' },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('asks a provider again once its listing failed, but reuses a good one', async () => {
    const listProvider = vi
      .fn()
      .mockResolvedValueOnce({ error: 'timed out', ok: false })
      .mockResolvedValue(listing([{ modelId: 'm' }]));
    const deps = { listProvider, priceListUrl: async () => '' };
    await findPriceHints(prisma, 'openrouter', 'm', deps);
    await findPriceHints(prisma, 'openrouter', 'm', deps);
    await findPriceHints(prisma, 'openrouter', 'm', deps);
    expect(listProvider).toHaveBeenCalledTimes(2);
  });
});
