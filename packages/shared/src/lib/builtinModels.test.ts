import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILTIN_MODELS, builtinModelSpec } from './builtinModels.js';
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
