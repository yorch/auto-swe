import { NodeSchema } from '@auto-swe/shared/workflow';
import { makeSpec as spec } from '@auto-swe/shared/workflow/testHelpers';
import { describe, expect, it } from 'vitest';
import { handlePortsFor } from '@/components/workflow/dagNode';
import { makeDefaultNodeFor } from '@/components/workflow/makeDefaultNode';
import { PRIMITIVE_GROUPS } from '@/components/workflow/NodePalette';
import { specToFlow } from '@/components/workflow/specToFlow';
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

  // Drift guard, driven by the Node union itself rather than a hardcoded list:
  // adding a 16th node type fails this automatically. `collectEdges` delegates
  // to shared's `nodeEdges`, and `handlePortsFor` declares which source handles
  // the rendered node exposes — an edge whose port has no matching handle is
  // one React Flow silently drops, which is exactly how agent / mcp / eval /
  // containerStep came to render as dead ends, and how a multi-option
  // `humanDecision` rendered its timeout branch and none of its decisions.
  const NODE_TYPES = NodeSchema.options.map((o) => o.shape.type.value);

  // The inverse direction, and the one that actually catches the original bug:
  // a node type that exposes a `next` port must emit a `next` edge when wired.
  // The parity test below cannot see this — a type that emits no edges at all
  // trivially has no orphaned ones.
  const NEXT_BEARING = NODE_TYPES.filter((t) =>
    handlePortsFor(makeDefaultNodeFor({ kind: 'primitive', nodeType: t })).some(
      (p) => p.id === 'next'
    )
  );

  it.each(NEXT_BEARING)('a %s node emits its next edge once wired', (type) => {
    const node = { ...makeDefaultNodeFor({ kind: 'primitive', nodeType: type }), next: 'done' };
    const result = layoutSpec(
      spec({ entry: 'a', nodes: { a: node, done: { status: 'SUCCESS', type: 'terminate' } } })
    );
    expect(result.edges).toEqual([{ from: 'a', kind: 'next', port: 'next', to: 'done' }]);
  });

  it.each(NODE_TYPES)('every edge a %s node emits leaves through a rendered handle', (type) => {
    const node = makeDefaultNodeFor({ kind: 'primitive', nodeType: type });
    const ports = new Set(handlePortsFor(node).map((p) => p.id));
    const emitted = layoutSpec(spec({ entry: 'a', nodes: { a: node } })).edges.map((e) => e.port);

    expect(emitted.filter((p) => !ports.has(p))).toEqual([]);
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

describe('node-type coverage', () => {
  it('the palette offers every node type exactly once', () => {
    const offered = PRIMITIVE_GROUPS.flatMap((g) => g.items.map((i) => i.type));

    const declared = NodeSchema.options.map((o) => o.shape.type.value);
    expect([...offered].sort()).toEqual([...declared].sort());
  });
});

describe('humanDecision option ports', () => {
  const decision = {
    onTimeout: 'expired',
    options: [
      { label: 'Ship it', next: 'ship', value: 'ship' },
      { label: 'Hold', next: 'hold', value: 'hold' },
    ],
    timeout: '24h',
    title: 'Ship?',
    type: 'humanDecision' as const,
  };
  const graph = spec({
    entry: 'decide',
    nodes: {
      decide: decision,
      expired: { status: 'TIMED_OUT' as const, type: 'terminate' as const },
      hold: { status: 'SKIPPED' as const, type: 'terminate' as const },
      ship: { status: 'SUCCESS' as const, type: 'terminate' as const },
    },
  });

  it('lays out every option edge, not just the timeout branch', () => {
    expect(layoutSpec(graph).edges).toEqual([
      { from: 'decide', kind: 'onTimeout', port: 'onTimeout', to: 'expired' },
      { from: 'decide', kind: 'onSubmit', port: 'options[0].next', to: 'ship' },
      { from: 'decide', kind: 'onSubmit', port: 'options[1].next', to: 'hold' },
    ]);
  });

  it('draws one handle per option, labelled with the option text', () => {
    expect(handlePortsFor(decision)).toEqual([
      { id: 'onTimeout', kind: 'onTimeout', label: 'timeout' },
      { id: 'options[0].next', kind: 'onSubmit', label: 'Ship it' },
      { id: 'options[1].next', kind: 'onSubmit', label: 'Hold' },
    ]);
  });

  it('gives each option edge a distinct React Flow id and source handle', () => {
    const { edges } = specToFlow(graph, {});
    const options = edges.filter((e) => e.sourceHandle?.startsWith('options['));

    expect(options.map((e) => e.sourceHandle)).toEqual(['options[0].next', 'options[1].next']);
    expect(new Set(edges.map((e) => e.id)).size).toBe(edges.length);
  });
});
