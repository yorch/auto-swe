import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Codemods are registered on a module-level list, so each test imports a
 * fresh module instance via `vi.resetModules()` + dynamic import to keep
 * registrations isolated.
 */

async function loadCodemodModule() {
  vi.resetModules();
  return await import('./codemod.js');
}

describe('codemod', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('is a no-op when input is already at the target version', async () => {
    const { migrateSpec } = await loadCodemodModule();
    const spec = { name: 'x', schemaVersion: 1 };
    expect(migrateSpec(spec, 1)).toEqual(spec);
  });

  it('rejects input without a numeric schemaVersion', async () => {
    const { migrateSpec } = await loadCodemodModule();
    expect(() => migrateSpec({}, 1)).toThrow(/missing schemaVersion/);
    expect(() => migrateSpec({ schemaVersion: 'one' }, 1)).toThrow(/missing schemaVersion/);
  });

  it('throws if no codemod is registered for the current version', async () => {
    const { migrateSpec } = await loadCodemodModule();
    expect(() => migrateSpec({ schemaVersion: 1 }, 2)).toThrow(
      /no codemod registered for schemaVersion 1/
    );
  });

  it('registers and applies a single codemod (1 → 2)', async () => {
    const { migrateSpec, registerCodemod } = await loadCodemodModule();
    registerCodemod({
      from: 1,
      to: 2,
      transform: (spec) => ({ ...(spec as object), renamed: true, schemaVersion: 2 }),
    });
    const out = migrateSpec({ original: true, schemaVersion: 1 }, 2) as Record<string, unknown>;
    expect(out.schemaVersion).toBe(2);
    expect(out.renamed).toBe(true);
    expect(out.original).toBe(true);
  });

  it('walks a chain of codemods (1 → 2 → 3)', async () => {
    const { migrateSpec, registerCodemod } = await loadCodemodModule();
    registerCodemod({
      from: 1,
      to: 2,
      transform: (s) => ({ ...(s as object), schemaVersion: 2, v1ToV2: true }),
    });
    registerCodemod({
      from: 2,
      to: 3,
      transform: (s) => ({ ...(s as object), schemaVersion: 3, v2ToV3: true }),
    });
    const out = migrateSpec({ schemaVersion: 1 }, 3) as Record<string, unknown>;
    expect(out.schemaVersion).toBe(3);
    expect(out.v1ToV2).toBe(true);
    expect(out.v2ToV3).toBe(true);
  });

  it('rejects registering a duplicate `from` version', async () => {
    const { registerCodemod } = await loadCodemodModule();
    registerCodemod({ from: 1, to: 2, transform: (s) => ({ ...(s as object), schemaVersion: 2 }) });
    expect(() => registerCodemod({ from: 1, to: 2, transform: (s) => s })).toThrow(
      /codemod from version 1 already registered/
    );
  });

  it('rejects a codemod whose `to` is not from + 1', async () => {
    const { registerCodemod } = await loadCodemodModule();
    expect(() => registerCodemod({ from: 1, to: 3, transform: (s) => s })).toThrow(
      /bump by exactly one/
    );
  });

  it('throws if a codemod returns invalid output (wrong schemaVersion)', async () => {
    const { migrateSpec, registerCodemod } = await loadCodemodModule();
    registerCodemod({
      from: 1,
      to: 2,
      transform: () => ({ schemaVersion: 5 }), // wrong target version
    });
    expect(() => migrateSpec({ schemaVersion: 1 }, 2)).toThrow(/returned invalid output/);
  });

  it('throws if a codemod returns a non-versioned object', async () => {
    const { migrateSpec, registerCodemod } = await loadCodemodModule();
    registerCodemod({
      from: 1,
      to: 2,
      transform: () => ({ foo: 'bar' }) as unknown,
    });
    expect(() => migrateSpec({ schemaVersion: 1 }, 2)).toThrow(/returned invalid output/);
  });
});
