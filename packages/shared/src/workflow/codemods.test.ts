import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the built-in codemod registrations exposed via `./codemods.js`.
 * Each test re-imports the modules fresh so the side-effect registration runs
 * against a clean codemod registry (`./codemod.ts` keeps codemods in a
 * module-level array).
 */

async function loadFresh() {
  vi.resetModules();
  // Import the codemod machinery first so we have a handle on `migrateSpec`.
  const codemod = await import('./codemod.js');
  // Importing `codemods.js` registers the built-in chain on the same module
  // instance (because vi.resetModules() reset the graph above).
  await import('./codemods.js');
  return codemod;
}

describe('built-in codemods', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('registers a v1 → v2 migration that bumps schemaVersion', async () => {
    const { migrateSpec } = await loadFresh();
    const out = migrateSpec({ name: 'old', schemaVersion: 1 }, 2) as Record<string, unknown>;
    expect(out.schemaVersion).toBe(2);
    expect(out.name).toBe('old');
  });

  it('preserves existing fields unchanged across v1 → v2', async () => {
    const { migrateSpec } = await loadFresh();
    const input = {
      description: 'whatever',
      entry: 'a',
      name: 'legacy',
      nodes: {
        a: { next: 'b', onError: 'continue', step: 'x', type: 'step' },
        b: { status: 'SUCCESS', type: 'terminate' },
      },
      schemaVersion: 1,
    };
    const out = migrateSpec(input, 2) as Record<string, unknown>;
    expect(out.schemaVersion).toBe(2);
    expect(out.entry).toBe('a');
    expect(out.name).toBe('legacy');
    expect(out.description).toBe('whatever');
    expect(out.nodes).toEqual(input.nodes);
  });

  it('throws when asked to migrate beyond the registered chain', async () => {
    const { migrateSpec } = await loadFresh();
    // Built-in chain currently ends at v4.
    expect(() => migrateSpec({ schemaVersion: 4 }, 99)).toThrow(/no codemod registered/);
  });

  it('does not mutate the original spec object', async () => {
    const { migrateSpec } = await loadFresh();
    const input = { name: 'x', schemaVersion: 1 };
    const out = migrateSpec(input, 2) as Record<string, unknown>;
    expect(input.schemaVersion).toBe(1);
    expect(out.schemaVersion).toBe(2);
  });

  it('chains v1 → v2 → v3 → v4 in a single migrateSpec call', async () => {
    const { migrateSpec } = await loadFresh();
    const input = {
      description: 'desc',
      entry: 'a',
      name: 'chain',
      nodes: { a: { status: 'SUCCESS', type: 'terminate' } },
      schemaVersion: 1,
    };
    const out = migrateSpec(input, 4) as Record<string, unknown>;
    expect(out.schemaVersion).toBe(4);
    expect(out.name).toBe('chain');
    expect(out.nodes).toEqual(input.nodes);
  });

  it('v2 → v3 preserves fanOut nodes verbatim', async () => {
    const { migrateSpec } = await loadFresh();
    const input = {
      entry: 'fan',
      name: 'preserve-fanout',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        fan: {
          join: 'done',
          over: { literal: [] },
          subgraph: 'done',
          type: 'fanOut',
        },
      },
      schemaVersion: 2,
    };
    const out = migrateSpec(input, 3) as Record<string, unknown>;
    expect(out.schemaVersion).toBe(3);
    expect(out.nodes).toEqual(input.nodes);
  });

  it('v3 → v4 preserves all node types verbatim (no shell auto-injection)', async () => {
    const { migrateSpec } = await loadFresh();
    const input = {
      entry: 'a',
      name: 'preserve-v3',
      nodes: {
        a: { next: 'b', step: 'x', type: 'step' },
        b: { status: 'SUCCESS', type: 'terminate' },
      },
      schemaVersion: 3,
    };
    const out = migrateSpec(input, 4) as Record<string, unknown>;
    expect(out.schemaVersion).toBe(4);
    expect(out.nodes).toEqual(input.nodes);
  });
});
