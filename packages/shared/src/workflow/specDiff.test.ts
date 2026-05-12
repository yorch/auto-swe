import { describe, expect, it } from 'vitest';
import type { WorkflowSpec } from './spec.js';
import { SPEC_SCHEMA_VERSION } from './spec.js';
import { diffSpecs, specsEqual } from './specDiff.js';

function spec(overrides: Partial<WorkflowSpec> = {}): WorkflowSpec {
  return {
    description: '',
    entry: 'start',
    name: 'test',
    nodes: {
      done: { status: 'SUCCESS', type: 'terminate' },
      start: { next: 'done', step: 'executeImplementation', type: 'step' },
    },
    schemaVersion: SPEC_SCHEMA_VERSION,
    ...overrides,
  };
}

describe('diffSpecs', () => {
  it('returns all unchanged when the specs are identical', () => {
    const a = spec();
    const b = spec();
    const d = diffSpecs(a, b);
    expect(d.addedNodes).toEqual([]);
    expect(d.removedNodes).toEqual([]);
    expect(d.changedNodes).toEqual([]);
    expect(d.unchangedNodes.sort()).toEqual(['done', 'start']);
    expect(d.metaChanges).toEqual([]);
    expect(specsEqual(a, b)).toBe(true);
  });

  it('detects an added node', () => {
    const a = spec();
    const b = spec({
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        mid: { next: 'done', step: 'runLint', type: 'step' },
        start: { next: 'mid', step: 'executeImplementation', type: 'step' },
      },
    });
    const d = diffSpecs(a, b);
    expect(d.addedNodes).toEqual(['mid']);
    expect(d.changedNodes).toEqual(['start']); // start.next changed
    expect(d.removedNodes).toEqual([]);
    expect(specsEqual(a, b)).toBe(false);
  });

  it('detects a removed node', () => {
    const a = spec({
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        mid: { next: 'done', step: 'runLint', type: 'step' },
        start: { next: 'mid', step: 'executeImplementation', type: 'step' },
      },
    });
    const b = spec();
    const d = diffSpecs(a, b);
    expect(d.removedNodes).toEqual(['mid']);
    expect(d.changedNodes).toEqual(['start']);
  });

  it('detects in-place node config changes', () => {
    const a = spec();
    const b = spec({
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        start: {
          config: { foo: 'bar' },
          next: 'done',
          step: 'executeImplementation',
          type: 'step',
        },
      },
    });
    const d = diffSpecs(a, b);
    expect(d.changedNodes).toEqual(['start']);
    expect(d.unchangedNodes).toEqual(['done']);
  });

  it('ignores property order in node objects', () => {
    // Build the b spec with permuted keys at runtime so biome's source action
    // can't statically reorder them and defeat the test.
    const permuted = Object.fromEntries(
      Object.entries({ next: 'done', step: 'executeImplementation', type: 'step' }).reverse()
    );
    const a = spec();
    const b = spec({
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        start: permuted as WorkflowSpec['nodes'][string],
      },
    });
    // Sanity check: the b literal really did land with reversed key order.
    expect(Object.keys(b.nodes.start as object)).toEqual(['type', 'step', 'next']);
    expect(specsEqual(a, b)).toBe(true);
  });

  it('captures top-level metadata changes', () => {
    const a = spec();
    const b = spec({ description: 'updated', name: 'renamed' });
    const d = diffSpecs(a, b);
    expect(d.metaChanges).toEqual([
      { after: 'renamed', before: 'test', field: 'name' },
      { after: 'updated', before: '', field: 'description' },
    ]);
  });

  it('sorts node-id outputs deterministically', () => {
    const a = spec({
      entry: 'a',
      nodes: {
        a: { next: 'b', step: 'runLint', type: 'step' },
        b: { next: 'c', step: 'runTests', type: 'step' },
        c: { status: 'SUCCESS', type: 'terminate' },
      },
    });
    const b = spec({
      entry: 'a',
      nodes: {
        a: { next: 'b', step: 'runLint', type: 'step' },
        b: { next: 'c', step: 'runBuild', type: 'step' }, // changed
        c: { status: 'SUCCESS', type: 'terminate' },
        d: { status: 'FAILED', type: 'terminate' }, // added
      },
    });
    const d = diffSpecs(a, b);
    expect(d.addedNodes).toEqual(['d']);
    expect(d.changedNodes).toEqual(['b']);
    expect(d.unchangedNodes).toEqual(['a', 'c']);
  });
});
