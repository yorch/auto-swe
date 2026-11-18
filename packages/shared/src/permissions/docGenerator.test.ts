import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { orgRuleApplies, requiresActiveTeam } from './can.js';
import { CATALOG, CATALOG_PARTS } from './catalog/index.js';
import { CONSTRAINTS } from './constraints.js';

/**
 * `scripts/permissions-catalog.mjs` reads the catalog source text without a TypeScript toolchain, so
 * `yarn docs:check` runs before an install. This pins that reader to the real catalog: if a catalog
 * file grows a shape the reader cannot follow, this fails instead of the doc quietly going wrong.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

// A computed specifier keeps the compiler from following the script outside this package.
const load = async () => {
  const specifier = join(ROOT, 'scripts/permissions-catalog.mjs');
  return (await import(specifier)) as {
    loadCatalog: (root: string) => Array<{ heading: string; entries: Array<[string, unknown]> }>;
    loadConstraints: (root: string) => unknown;
    needsActiveTeam: (def: unknown) => boolean;
    orgConfers: (def: unknown) => boolean;
  };
};

describe('the documentation generator reads the catalog faithfully', () => {
  it('yields exactly the catalog, domain by domain', async () => {
    const { loadCatalog } = await load();
    const groups = loadCatalog(ROOT);
    const parts = Object.values(CATALOG_PARTS);
    expect(groups.length).toBe(parts.length);
    const read = Object.fromEntries(groups.flatMap((g) => g.entries));
    expect(read).toEqual(CATALOG);
    expect(groups.flatMap((g) => g.entries.map(([k]) => k)).sort()).toEqual(
      Object.keys(CATALOG).sort()
    );
  });

  it('yields exactly the constraints', async () => {
    const { loadConstraints } = await load();
    expect(loadConstraints(ROOT)).toEqual(CONSTRAINTS);
  });

  it('computes the effective columns as the resolver does', async () => {
    const { needsActiveTeam, orgConfers } = await load();
    for (const [key, def] of Object.entries(CATALOG)) {
      expect(needsActiveTeam(def), key).toBe(requiresActiveTeam(def));
      expect(orgConfers(def), key).toBe(orgRuleApplies(def));
    }
  });
});
