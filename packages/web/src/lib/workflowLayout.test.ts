import { makeSpec as spec } from '@auto-swe/shared/workflow/testHelpers';
import { describe, expect, it } from 'vitest';
import { layoutSpec, NODE_WIDTH } from './workflowLayout.js';

describe('layoutSpec', () => {
  it('returns an empty layout for an empty node map', () => {
    const result = layoutSpec(spec({ nodes: {} }));
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
  });

  it('places a single-node spec at finite coordinates', () => {
    const result = layoutSpec(
      spec({
        entry: 'start',
        nodes: {
          start: { status: 'SUCCESS', type: 'terminate' },
        },
      })
    );
    expect(result.nodes).toHaveLength(1);
    const start = result.nodes[0];
    expect(start).toBeDefined();
    expect(Number.isFinite(start?.x)).toBe(true);
    expect(Number.isFinite(start?.y)).toBe(true);
  });

  it('orders downstream nodes left-to-right along the edge chain', () => {
    const result = layoutSpec(
      spec({
        entry: 'a',
        nodes: {
          a: { next: 'b', step: 'x', type: 'step' },
          b: { next: 'c', step: 'y', type: 'step' },
          c: { status: 'SUCCESS', type: 'terminate' },
        },
      })
    );
    const byId = new Map(result.nodes.map((n) => [n.id, n]));
    const a = byId.get('a');
    const b = byId.get('b');
    const c = byId.get('c');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(c).toBeDefined();
    // dagre's network-simplex layout doesn't emit fixed rank coordinates, but
    // the LR ranking direction guarantees downstream nodes sit to the right.
    expect((a?.x ?? 0) + NODE_WIDTH).toBeLessThanOrEqual(b?.x ?? 0);
    expect((b?.x ?? 0) + NODE_WIDTH).toBeLessThanOrEqual(c?.x ?? 0);
  });

  it('collects cond + signal + fanOut edges with kinds', () => {
    const result = layoutSpec(
      spec({
        entry: 'cond1',
        nodes: {
          cond1: { expr: 'true', onFalse: 'f', onTrue: 't', type: 'cond' },
          f: { status: 'FAILED', type: 'terminate' },
          t: { status: 'SUCCESS', type: 'terminate' },
        },
      })
    );
    const kinds = result.edges.map((e) => e.kind).sort();
    expect(kinds).toEqual(['onFalse', 'onTrue']);
  });

  it('tolerates cycles without infinite-looping', () => {
    const result = layoutSpec(
      spec({
        entry: 'a',
        nodes: {
          a: { expr: 'true', onFalse: 'b', onTrue: 'b', type: 'cond' },
          b: { expr: 'true', onFalse: 'done', onTrue: 'a', type: 'cond' },
          done: { status: 'SUCCESS', type: 'terminate' },
        },
      })
    );
    expect(result.nodes).toHaveLength(3);
    // All three nodes get finite positions even with the b→a back-edge.
    for (const n of result.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it('omits edges that point to unknown nodes', () => {
    const result = layoutSpec(
      spec({
        entry: 'a',
        // biome-ignore lint/suspicious/noExplicitAny: testing a dangling-edge spec
        nodes: { a: { next: 'ghost', step: 'x', type: 'step' } } as any,
      })
    );
    expect(result.edges).toEqual([]);
  });

  it('returns a bounding-box width and height that fit every node', () => {
    const result = layoutSpec(
      spec({
        entry: 'a',
        nodes: {
          a: { next: 'b', step: 'x', type: 'step' },
          b: { status: 'SUCCESS', type: 'terminate' },
        },
      })
    );
    // Bounding box should cover at least one node width + the gap between two
    // ranks — exact value depends on dagre's spacing, so assert lower bounds.
    expect(result.width).toBeGreaterThanOrEqual(NODE_WIDTH * 2);
    expect(result.height).toBeGreaterThan(0);
  });
});
