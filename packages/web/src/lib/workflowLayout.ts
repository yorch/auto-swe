/**
 * Hierarchical layout for WorkflowSpec DAGs via dagre.
 *
 * The previous implementation rolled its own BFS rank assignment. That worked
 * for tiny demo graphs but flattened branchy real-world workflows (default-
 * engineering's 35 nodes ended up in a single horizontal strip because each
 * forward edge bumped a node to a fresh rank with indexInRank=0). dagre's
 * network-simplex layered layout handles branches, back-edges, and varying
 * fan-in/out cleanly, so we delegate to it and translate its results into
 * the {nodes, edges, width, height} shape the rest of the app already uses.
 */
import { type Node, nodeEdges, type WorkflowSpec } from '@auto-swe/shared/workflow';
import dagre from 'dagre';

export type EdgeKind =
  | 'next'
  | 'onTrue'
  | 'onFalse'
  | 'onReceive'
  | 'onTimeout'
  | 'subgraph'
  | 'join'
  | 'onApprove'
  | 'onReject'
  | 'onRequestChanges'
  | 'onSubmit'
  | 'onFailure'
  | 'onExhausted';

export interface LayoutEdge {
  from: string;
  to: string;
  /** Styling/labelling bucket. */
  kind: EdgeKind;
  /** The spec field this edge leaves through, and the source handle id the
   *  node draws for it. Equal to `kind` except for a `humanDecision` option,
   *  which is `options[i].next`. */
  port: string;
}

export interface LayoutNode {
  id: string;
  node: Node;
  x: number;
  y: number;
  /** Reserved for compatibility with the older renderer — dagre doesn't
   *  expose rank or indexInRank directly. */
  rank: number;
  indexInRank: number;
}

export interface LayoutResult {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 88;

/**
 * Outgoing edges of a node, in the shape this renderer needs.
 *
 * Traversal is not re-derived here: `nodeEdges` in the shared spec is the
 * single source of truth for which fields of which node types are edges, and
 * already backs the schema's ref validation and `validateSpec`'s reachability
 * analysis. A second hand-maintained switch here is what let `agent`, `mcp`,
 * `eval` and `containerStep` lose their outgoing edges in the rendered graph
 * while shared had them right all along. This only maps field names onto the
 * `EdgeKind` the renderer colours, labels and ports by.
 */
function collectEdges(node: Node, id: string): LayoutEdge[] {
  return nodeEdges(node).map(([field, to]) => ({
    from: id,
    // `humanDecision` labels each option edge `options[i].next` and draws one
    // handle per option, so the kind is only the styling bucket there. Every
    // other field name is itself an EdgeKind and its own port.
    kind: (field.startsWith('options[') ? 'onSubmit' : field) as EdgeKind,
    port: field,
    to,
  }));
}

/**
 * @param extraEdges Edges that exist only in the picture — the exits of a
 *   collapsed group's card, which no spec node carries. Drawn and laid out like any other.
 */
export function layoutSpec(
  spec: WorkflowSpec,
  extraEdges: readonly LayoutEdge[] = []
): LayoutResult {
  const nodeIds = Object.keys(spec.nodes);
  if (nodeIds.length === 0) {
    return { edges: [], height: 0, nodes: [], width: 0 };
  }

  // Collect logical edges first — used both for layout input and for the
  // returned LayoutEdge list (which preserves edge kind for styling).
  const allEdges: LayoutEdge[] = [];
  for (const id of nodeIds) {
    for (const e of collectEdges(spec.nodes[id] as Node, id)) {
      // Drop edges to unknown nodes (shouldn't happen with a parsed spec, but
      // partially-edited specs in the editor may dangle).
      if (e.to in spec.nodes) {
        allEdges.push(e);
      }
    }
  }

  for (const e of extraEdges) {
    if (e.from in spec.nodes && e.to in spec.nodes) {
      allEdges.push(e);
    }
  }

  // dagre sees only the node ids and the (from, to) pairs. Editing a field inside a node,
  // a run's status changing or a diff marker appearing leaves both alone, so the positions
  // are reused instead of running the layered layout again on every keystroke or poll.
  const key = JSON.stringify([nodeIds, allEdges.map((e) => [e.from, e.to])]);
  let placed = layoutCache.get(key);
  if (placed) {
    // Refresh recency: the cache evicts the least recently used shape.
    layoutCache.delete(key);
  } else {
    placed = computePositions(nodeIds, allEdges);
    if (layoutCache.size >= LAYOUT_CACHE_SIZE) {
      layoutCache.delete(layoutCache.keys().next().value as string);
    }
  }
  layoutCache.set(key, placed);

  const nodes: LayoutNode[] = nodeIds.map((id, i) => ({
    id,
    indexInRank: 0,
    node: spec.nodes[id] as Node,
    rank: 0,
    x: placed.xs[i] as number,
    y: placed.ys[i] as number,
  }));

  return { edges: allEdges, height: placed.height, nodes, width: placed.width };
}

interface Placement {
  xs: number[];
  ys: number[];
  width: number;
  height: number;
}

/** Layouts kept by graph shape; a handful covers flipping between versions or a diff's two sides. */
const LAYOUT_CACHE_SIZE = 8;
const layoutCache = new Map<string, Placement>();

function computePositions(nodeIds: string[], allEdges: LayoutEdge[]): Placement {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    edgesep: 24,
    marginx: 12,
    marginy: 12,
    nodesep: 28,
    rankdir: 'LR',
    ranker: 'network-simplex',
    ranksep: 80,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const id of nodeIds) {
    g.setNode(id, { height: NODE_HEIGHT, width: NODE_WIDTH });
  }
  for (const e of allEdges) {
    // dagre dedupes by (from,to); multi-edges with different kinds (e.g.
    // fanOut's subgraph + join to the same node) collapse to one layout edge.
    // That's fine — kind is preserved in `allEdges` for rendering.
    g.setEdge(e.from, e.to);
  }

  dagre.layout(g);

  let maxX = 0;
  let maxY = 0;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const id of nodeIds) {
    const n = g.node(id);
    // dagre returns the *centre* of the node; React Flow expects the top-left
    // corner. Convert here so the rest of the app can keep treating positions
    // as top-left.
    const x = n.x - NODE_WIDTH / 2;
    const y = n.y - NODE_HEIGHT / 2;
    maxX = Math.max(maxX, x + NODE_WIDTH);
    maxY = Math.max(maxY, y + NODE_HEIGHT);
    xs.push(x);
    ys.push(y);
  }
  return { height: Math.max(0, maxY), width: Math.max(0, maxX), xs, ys };
}

export type DiffKind = 'added' | 'removed' | 'changed';
