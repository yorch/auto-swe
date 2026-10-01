/**
 * Pure keyboard-navigation helpers for the workflow DAG.
 *
 * Kept free of React Flow runtime imports (type-only) so the traversal logic is
 * unit-testable without a canvas. The read-only viewer (`WorkflowDag`) wires
 * these into an arrow-key handler so a keyboard/screen-reader user can walk the
 * graph edge-by-edge instead of it being pointer-only.
 */
import type { Edge, Node } from '@xyflow/react';

export type NavDirection = 'next' | 'prev' | 'first' | 'nextSibling' | 'prevSibling';

type NavNode = Pick<Node, 'id'> & { position?: { x: number; y: number } };
type NavEdge = Pick<Edge, 'source' | 'target'>;

/** Order candidate ids by vertical position (topmost first), then id, so
 *  traversal across a multi-output node (cond, fanOut) is deterministic. */
function orderByPosition(ids: string[], nodes: NavNode[]): string[] {
  const posById = new Map(nodes.map((n) => [n.id, n.position]));
  return [...ids].sort((a, b) => {
    const ya = posById.get(a)?.y ?? 0;
    const yb = posById.get(b)?.y ?? 0;
    if (ya !== yb) {
      return ya - yb;
    }
    return a.localeCompare(b);
  });
}

/** The entry node — one with no incoming edges (topmost when several), falling
 *  back to the first node so a cyclic or malformed graph still has a target. */
export function entryNodeId(nodes: NavNode[], edges: NavEdge[]): string | null {
  if (nodes.length === 0) {
    return null;
  }
  const withIncoming = new Set(edges.map((e) => e.target));
  const roots = nodes.map((n) => n.id).filter((id) => !withIncoming.has(id));
  const ordered = orderByPosition(roots.length > 0 ? roots : nodes.map((n) => n.id), nodes);
  return ordered[0] ?? null;
}

/**
 * Compute the node id to move selection to for one keyboard step.
 * - `next`: follow the first outgoing edge (targets ordered by position) from
 *   `selectedId`.
 * - `prev`: follow the first incoming edge back to its source.
 * - `first`: the entry node.
 * - `nextSibling` / `prevSibling`: step to the node below / above in the group
 *   of nodes that share a parent with `selectedId` — the other branches of a
 *   `cond`, `fanOut` or human gate. `next` alone only ever reaches the topmost
 *   target, which left every other branch unreachable from the keyboard.
 *
 * Returns `null` when there is nowhere to go (caller keeps the current
 * selection). With nothing selected, `next`/`prev` both seed at the entry node.
 */
export function adjacentNodeId(
  selectedId: string | null,
  direction: NavDirection,
  nodes: NavNode[],
  edges: NavEdge[]
): string | null {
  if (direction === 'first' || selectedId === null) {
    return entryNodeId(nodes, edges);
  }
  if (direction === 'nextSibling' || direction === 'prevSibling') {
    const parents = new Set(edges.filter((e) => e.target === selectedId).map((e) => e.source));
    const siblings = orderByPosition(
      [
        ...new Set(
          edges.filter((e) => parents.has(e.source) && e.target !== selectedId).map((e) => e.target)
        ),
        selectedId,
      ],
      nodes
    );
    const at = siblings.indexOf(selectedId);
    return siblings[direction === 'nextSibling' ? at + 1 : at - 1] ?? null;
  }
  const candidates =
    direction === 'next'
      ? edges.filter((e) => e.source === selectedId).map((e) => e.target)
      : edges.filter((e) => e.target === selectedId).map((e) => e.source);
  const ordered = orderByPosition(candidates, nodes);
  return ordered[0] ?? null;
}
