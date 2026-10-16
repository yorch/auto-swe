import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async () => []),
}));

import {
  loadPriceList,
  lookupPriceList,
  PRICE_LIST_ERRORS,
  resetPriceListCache,
} from './modelPriceList.js';

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
  resetPriceListCache();
});

describe('lookupPriceList', () => {
  it('reads a bare first-party key, per MTok, with cache rates as multiples of input', () => {
    expect(lookupPriceList(TABLE, 'anthropic', 'claude-x-1')).toEqual({
      cacheReadMultiplier: 0.1,
      cacheWrite1hMultiplier: 2,
      cacheWrite5mMultiplier: 1.25,
      inputUsdPerMTok: 3,
      kind: 'CHAT',
      matchedId: 'claude-x-1',
      outputUsdPerMTok: 15,
    });
  });

  it("maps google to LiteLLM's gemini prefix", () => {
    expect(lookupPriceList(TABLE, 'google', 'gemini-x-pro')).toMatchObject({
      inputUsdPerMTok: 1.25,
      matchedId: 'gemini/gemini-x-pro',
      outputUsdPerMTok: 10,
    });
  });

  it('prices an embedding that states no output rate at 0 output', () => {
    expect(lookupPriceList(TABLE, 'openai', 'text-embed-x')).toMatchObject({
      inputUsdPerMTok: 0.02,
      kind: 'EMBEDDING',
      outputUsdPerMTok: 0,
    });
  });

  it("never answers with another provider's entry for the same id", () => {
    expect(lookupPriceList(TABLE, 'openai', 'gpt-x')).toBeNull();
    expect(lookupPriceList(TABLE, 'openai', 'claude-x-1')).toBeNull();
    expect(lookupPriceList(TABLE, 'openai', 'missing')).toBeNull();
  });
});

describe('loadPriceList', () => {
  it('is off, and fetches nothing, when the URL is empty', async () => {
    const fetcher = vi.fn();
    expect(await loadPriceList({ fetcher: fetcher as never, priceListUrl: async () => '' })).toBe(
      null
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns the table with the URL it came from, refusing redirects', async () => {
    const fetcher = vi.fn(async () => jsonResponse(TABLE));
    const result = await loadPriceList({
      fetcher: fetcher as never,
      priceListUrl: async () => LIST_URL,
    });
    expect(result).toMatchObject({ ok: true, url: LIST_URL });
    expect(fetcher).toHaveBeenCalledWith(LIST_URL, expect.objectContaining({ redirect: 'error' }));
  });

  it('refuses a price list that is not a JSON object, or is too large', async () => {
    const notObject = await loadPriceList({
      fetcher: (async () => new Response('<html>')) as never,
      priceListUrl: async () => LIST_URL,
    });
    expect(notObject).toEqual({ error: PRICE_LIST_ERRORS.unrecognised, ok: false });
    resetPriceListCache();
    const huge = await loadPriceList({
      fetcher: (async () =>
        new Response('{}', { headers: { 'content-length': String(64 * 1024 * 1024) } })) as never,
      priceListUrl: async () => LIST_URL,
    });
    expect(huge).toEqual({ error: PRICE_LIST_ERRORS.tooLarge, ok: false });
  });

  it('refuses a price list URL on a blocked address without fetching it', async () => {
    const fetcher = vi.fn();
    const result = await loadPriceList({
      fetcher: fetcher as never,
      priceListUrl: async () => 'http://169.254.169.254/prices.json',
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result).toEqual({ error: 'blocked address', ok: false });
  });

  it('keeps a fetched list for hours, and retries a failed one after minutes', async () => {
    let now = 0;
    const ok = vi.fn(async () => jsonResponse(TABLE));
    const deps = { fetcher: ok as never, now: () => now, priceListUrl: async () => LIST_URL };
    await loadPriceList(deps);
    now += 60 * 60_000;
    await loadPriceList(deps);
    expect(ok).toHaveBeenCalledTimes(1);

    resetPriceListCache();
    now = 0;
    const failing = vi.fn(async () => jsonResponse({}, 503));
    const failDeps = { ...deps, fetcher: failing as never };
    await loadPriceList(failDeps);
    now += 6 * 60_000;
    await loadPriceList(failDeps);
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
