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
 * The provider pricing pages the file's header cites (`- Anthropic: https://…`),
 * as provider -> host. The allowlist is read from the header, so the header and the
 * rows can never disagree, and a row for a provider the header does not cite fails.
 */
function citedPricingHosts(): Map<string, string> {
  const source = readFileSync(
    fileURLToPath(new URL('./builtinModels.ts', import.meta.url)),
    'utf8'
  );
  const header = source.slice(0, source.indexOf('*/'));
  const hosts = new Map<string, string>();
  for (const m of header.matchAll(/^ \* - (\w+):\s+(https:\/\/\S+)/gm)) {
    hosts.set(m[1].toLowerCase(), new URL(m[2]).hostname);
  }
  return hosts;
}

/** Why a row's citation is not acceptable, or null when it is. */
function priceSourceProblem(
  m: { provider: string; priceSourceUrl?: string },
  hosts: Map<string, string>
): string | null {
  let url: URL;
  try {
    url = new URL(m.priceSourceUrl ?? '');
  } catch {
    return 'priceSourceUrl is missing or not a URL';
  }
  if (url.protocol !== 'https:') {
    return 'priceSourceUrl is not https';
  }
  const host = hosts.get(m.provider);
  if (!host) {
    return `the header cites no pricing page for provider '${m.provider}'`;
  }
  return url.hostname === host ? null : `priceSourceUrl host ${url.hostname} is not ${host}`;
}

describe('priceSourceUrl', () => {
  const hosts = citedPricingHosts();

  it('reads one host per provider from the header', () => {
    expect([...hosts.keys()].sort()).toEqual(['anthropic', 'google', 'openai']);
  });

  it('is an https URL on its provider pricing host, on every row', () => {
    for (const m of BUILTIN_MODELS) {
      expect(priceSourceProblem(m, hosts), builtinModelSpec(m)).toBeNull();
    }
  });

  it('rejects a missing, non-https, off-host or uncited citation', () => {
    expect(priceSourceProblem({ provider: 'openai' }, hosts)).toMatch(/missing/);
    expect(
      priceSourceProblem(
        { priceSourceUrl: 'http://developers.openai.com/x', provider: 'openai' },
        hosts
      )
    ).toMatch(/not https/);
    expect(
      priceSourceProblem(
        { priceSourceUrl: 'https://example.com/pricing', provider: 'openai' },
        hosts
      )
    ).toMatch(/not developers.openai.com/);
    expect(
      priceSourceProblem({ priceSourceUrl: 'https://x.ai/pricing', provider: 'xai' }, hosts)
    ).toMatch(/cites no pricing page/);
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
