import { makeSpec as spec } from '@auto-swe/shared/workflow/testHelpers';
import { describe, expect, it } from 'vitest';
import { layoutSpec, NODE_WIDTH, RANK_X_SPACING } from './workflowLayout.js';

describe('layoutSpec', () => {
  it('returns an empty layout for an empty node map', () => {
    const result = layoutSpec(spec({ nodes: {} }));
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
  });

  it('places the entry node at rank 0', () => {
    const result = layoutSpec(
      spec({
        entry: 'start',
        nodes: {
          start: { status: 'SUCCESS', type: 'terminate' },
        },
      })
    );
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.rank).toBe(0);
    expect(result.nodes[0]?.x).toBe(0);
  });

  it('ranks downstream nodes by longest-path BFS', () => {
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
    expect(byId.get('a')?.rank).toBe(0);
    expect(byId.get('b')?.rank).toBe(1);
    expect(byId.get('c')?.rank).toBe(2);
    expect(byId.get('c')?.x).toBe(2 * RANK_X_SPACING);
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
    // Back-edge b → a is recorded but doesn't change a's rank.
    const a = result.nodes.find((n) => n.id === 'a');
    expect(a?.rank).toBe(0);
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

  it('computes width covering the deepest rank', () => {
    const result = layoutSpec(
      spec({
        entry: 'a',
        nodes: {
          a: { next: 'b', step: 'x', type: 'step' },
          b: { status: 'SUCCESS', type: 'terminate' },
        },
      })
    );
    // maxRank=1 → (1+1) * RANK_X_SPACING + NODE_WIDTH
    expect(result.width).toBe(2 * RANK_X_SPACING + NODE_WIDTH);
  });
});
