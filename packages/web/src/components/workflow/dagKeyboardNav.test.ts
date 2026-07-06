import { describe, expect, it } from 'vitest';
import { adjacentNodeId, entryNodeId } from './dagKeyboardNav';

// A small diamond graph: a → {b, c} → d. `b` sits above `c`.
const nodes = [
  { id: 'a', position: { x: 0, y: 0 } },
  { id: 'b', position: { x: 100, y: -20 } },
  { id: 'c', position: { x: 100, y: 40 } },
  { id: 'd', position: { x: 200, y: 0 } },
];
const edges = [
  { source: 'a', target: 'b' },
  { source: 'a', target: 'c' },
  { source: 'b', target: 'd' },
  { source: 'c', target: 'd' },
];

describe('entryNodeId', () => {
  it('returns the node with no incoming edges', () => {
    expect(entryNodeId(nodes, edges)).toBe('a');
  });

  it('falls back to the topmost node when every node has an incoming edge (cycle)', () => {
    const cyclic = [
      { source: 'x', target: 'y' },
      { source: 'y', target: 'x' },
    ];
    const cyc = [
      { id: 'y', position: { x: 0, y: 50 } },
      { id: 'x', position: { x: 0, y: 0 } },
    ];
    expect(entryNodeId(cyc, cyclic)).toBe('x');
  });

  it('returns null for an empty graph', () => {
    expect(entryNodeId([], [])).toBeNull();
  });
});

describe('adjacentNodeId', () => {
  it('follows the first outgoing edge (topmost target) for next', () => {
    expect(adjacentNodeId('a', 'next', nodes, edges)).toBe('b');
  });

  it('follows the first incoming edge (topmost source) for prev', () => {
    expect(adjacentNodeId('d', 'prev', nodes, edges)).toBe('b');
  });

  it('seeds at the entry node when nothing is selected', () => {
    expect(adjacentNodeId(null, 'next', nodes, edges)).toBe('a');
    expect(adjacentNodeId(null, 'prev', nodes, edges)).toBe('a');
  });

  it('returns the entry node for first regardless of selection', () => {
    expect(adjacentNodeId('d', 'first', nodes, edges)).toBe('a');
  });

  it('returns null at a terminal node (no outgoing edge)', () => {
    expect(adjacentNodeId('d', 'next', nodes, edges)).toBeNull();
  });

  it('returns null at the entry node going prev (no incoming edge)', () => {
    expect(adjacentNodeId('a', 'prev', nodes, edges)).toBeNull();
  });
});
