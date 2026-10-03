import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILTIN_MODELS, builtinModelSpec, cacheMultipliers } from './builtinModels.js';
import { parseProviderModelSpec } from './modelSpec.js';
import { PREVIOUS_DEFAULT_MODEL_SPECS, SWE_AGENTS } from './syncBuiltins.js';

const bySpec = new Map(BUILTIN_MODELS.map((m) => [builtinModelSpec(m), m]));

/**
 * The embedding default is seeded by SQL, not TypeScript, so read it from the
 * migration that inserts it rather than restating it here.
 */
function seededEmbeddingSpec(): string {
  const sql = readFileSync(
    fileURLToPath(
      new URL(
        '../prisma/migrations/00000000000001_custom_constraints_and_indexes/migration.sql',
        import.meta.url
      )
    ),
    'utf8'
  );
  const match = /INSERT INTO "embedding_configs"[^;]*VALUES \('default', '([^']+)'\)/.exec(sql);
  if (!match?.[1]) {
    throw new Error('embedding_configs default seed not found in the migration');
  }
  return match[1];
}

/**
 * The pricing host each provider's prices may be cited to. FIXED here, in the test, and
 * deliberately not read from `builtinModels.ts`: the catalog refresh edits that file, so
 * an allowlist derived from it could be widened by the same diff it is meant to check.
 * Adding a provider is a deliberate edit to this map, which the refresh's changed-files
 * guard keeps out of the agent's diff.
 */
const PRICING_HOSTS: Readonly<Record<string, string>> = {
  anthropic: 'platform.claude.com',
  google: 'ai.google.dev',
  openai: 'developers.openai.com',
};

const source = readFileSync(fileURLToPath(new URL('./builtinModels.ts', import.meta.url)), 'utf8');

/** Every `- Provider: https://…` line of the header, in order, duplicates kept. */
function headerCitations(text: string): Array<[provider: string, host: string]> {
  const header = text.slice(0, text.indexOf('*/'));
  return [...header.matchAll(/^ \* - (\w+):\s+(https:\/\/\S+)/gm)].map(
    (m) => [(m[1] as string).toLowerCase(), new URL(m[2] as string).hostname] as [string, string]
  );
}

/** Why a header does not match {@link PRICING_HOSTS} exactly, or null when it does. */
function headerProblem(text: string): string | null {
  const got = headerCitations(text)
    .map(([p, h]) => `${p}=${h}`)
    .sort();
  const want = Object.entries(PRICING_HOSTS)
    .map(([p, h]) => `${p}=${h}`)
    .sort();
  return JSON.stringify(got) === JSON.stringify(want)
    ? null
    : `header cites [${got.join(', ')}], expected [${want.join(', ')}]`;
}

/** Why a row's citation is not acceptable, or null when it is. */
function priceSourceProblem(m: { provider: string; priceSourceUrl?: string }): string | null {
  let url: URL;
  try {
    url = new URL(m.priceSourceUrl ?? '');
  } catch {
    return 'priceSourceUrl is missing or not a URL';
  }
  if (url.protocol !== 'https:') {
    return 'priceSourceUrl is not https';
  }
  const host = PRICING_HOSTS[m.provider];
  if (!host) {
    return `no pricing host is allowed for provider '${m.provider}'`;
  }
  return url.hostname === host ? null : `priceSourceUrl host ${url.hostname} is not ${host}`;
}

describe('priceSourceUrl', () => {
  it('matches the fixed provider -> host map in the file header, exactly', () => {
    expect(headerProblem(source)).toBeNull();
  });

  it('fails a header with a second line for a provider, pointing at another host', () => {
    // The reviewer's repro: a duplicate line used to override the real one in a Map.
    const evil = source.replace(
      ' * - Google:',
      ' * - OpenAI:    https://evil.example/pricing\n * - Google:'
    );
    expect(headerProblem(evil)).toMatch(/evil\.example/);
  });

  it('fails a header whose host was swapped, and rows swapped to match it', () => {
    const evil = source
      .replaceAll('developers.openai.com', 'evil.example')
      .replaceAll("'https://evil.example/api/docs/pricing'", "'https://evil.example/pricing'");
    expect(headerProblem(evil)).not.toBeNull();
    expect(
      priceSourceProblem({ priceSourceUrl: 'https://evil.example/pricing', provider: 'openai' })
    ).toMatch(/not developers\.openai\.com/);
  });

  it('is an https URL on its provider pricing host, on every row', () => {
    for (const m of BUILTIN_MODELS) {
      expect(priceSourceProblem(m), builtinModelSpec(m)).toBeNull();
    }
  });

  it('rejects a missing, non-https, off-host or unlisted-provider citation', () => {
    expect(priceSourceProblem({ provider: 'openai' })).toMatch(/missing/);
    expect(
      priceSourceProblem({ priceSourceUrl: 'http://developers.openai.com/x', provider: 'openai' })
    ).toMatch(/not https/);
    expect(
      priceSourceProblem({ priceSourceUrl: 'https://ai.google.dev/pricing', provider: 'openai' })
    ).toMatch(/not developers\.openai\.com/);
    expect(priceSourceProblem({ priceSourceUrl: 'https://x.ai/pricing', provider: 'xai' })).toMatch(
      /no pricing host/
    );
  });
});

describe('BUILTIN_MODELS', () => {
  it('lists each spec once, in the form parseProviderModelSpec produces', () => {
    expect(bySpec.size).toBe(BUILTIN_MODELS.length);
    for (const m of BUILTIN_MODELS) {
      expect(parseProviderModelSpec(builtinModelSpec(m))).toEqual({
        modelId: m.modelId,
        provider: m.provider,
      });
    }
  });

  it('carries finite, non-negative prices', () => {
    for (const m of BUILTIN_MODELS) {
      for (const price of [m.inputUsdPerMTok, m.outputUsdPerMTok]) {
        expect(Number.isFinite(price) && price >= 0, builtinModelSpec(m)).toBe(true);
      }
    }
  });

  // A seeded spec with no entry is priced at $0, which USD budgets never see.
  // These turn that into a red build for anything this repo seeds.
  it('prices every seeded agent default as an active chat model', () => {
    const specs = SWE_AGENTS.flatMap((a) => (a.modelSpec ? [a.modelSpec] : []));
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(bySpec.get(spec), spec).toMatchObject({ kind: 'CHAT', status: 'ACTIVE' });
    }
  });

  it('prices both sides of every previous-default migration', () => {
    // A deployment that has not restarted since the upgrade still runs the old one.
    for (const [from, to] of Object.entries(PREVIOUS_DEFAULT_MODEL_SPECS)) {
      expect(bySpec.has(from), from).toBe(true);
      expect(bySpec.has(to), to).toBe(true);
    }
  });

  it('prices the seeded embedding default as an embedding model', () => {
    const spec = seededEmbeddingSpec();
    expect(bySpec.get(spec), spec).toMatchObject({ kind: 'EMBEDDING' });
  });
});

describe('cacheMultipliers', () => {
  it('applies the Anthropic rule to every Claude model, catalog-only ones included', () => {
    expect(cacheMultipliers('anthropic/claude-opus-4-8')).toEqual({ read: 0.1, write: 1.25 });
    expect(cacheMultipliers('anthropic/claude-not-in-code')).toEqual({ read: 0.1, write: 1.25 });
  });

  it('uses a per-model rate where the vendor prices caching per model', () => {
    expect(cacheMultipliers('openai/gpt-5')).toEqual({ read: 0.1, write: 1 });
  });

  it('prices cached input as ordinary input when no discount is known', () => {
    expect(cacheMultipliers('openai/gpt-5.5-pro')).toEqual({ read: 1, write: 1 });
    expect(cacheMultipliers('google/gemini-2.5-pro')).toEqual({ read: 1, write: 1 });
    expect(cacheMultipliers('nonsense')).toEqual({ read: 1, write: 1 });
  });
});
