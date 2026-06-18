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
import type { Node, WorkflowSpec } from '@auto-swe/shared/workflow';
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
  | 'onSubmit';

export interface LayoutEdge {
  from: string;
  to: string;
  kind: EdgeKind;
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
export const RANK_X_SPACING = 240;
export const NODE_Y_SPACING = 80;

function collectEdges(node: Node, id: string): LayoutEdge[] {
  const edges: LayoutEdge[] = [];
  switch (node.type) {
    case 'step':
    case 'set':
    case 'shell':
      if (node.next) {
        edges.push({ from: id, kind: 'next', to: node.next });
      }
      break;
    case 'cond':
      edges.push({ from: id, kind: 'onTrue', to: node.onTrue });
      edges.push({ from: id, kind: 'onFalse', to: node.onFalse });
      break;
    case 'signal':
      edges.push({ from: id, kind: 'onReceive', to: node.onReceive });
      edges.push({ from: id, kind: 'onTimeout', to: node.onTimeout });
      break;
    case 'fanOut':
      edges.push({ from: id, kind: 'subgraph', to: node.subgraph });
      edges.push({ from: id, kind: 'join', to: node.join });
      break;
    case 'terminate':
      break;
    case 'humanApproval':
      edges.push({ from: id, kind: 'onApprove', to: node.onApprove });
      edges.push({ from: id, kind: 'onReject', to: node.onReject });
      edges.push({ from: id, kind: 'onTimeout', to: node.onTimeout });
      break;
    case 'humanDecision':
      edges.push({ from: id, kind: 'onTimeout', to: node.onTimeout });
      for (const opt of node.options) {
        edges.push({ from: id, kind: 'onSubmit', to: opt.next });
      }
      break;
    case 'humanInput':
    case 'humanReview':
      edges.push({ from: id, kind: 'onSubmit', to: node.onSubmit });
      edges.push({ from: id, kind: 'onTimeout', to: node.onTimeout });
      break;
  }
  return edges;
}

export function layoutSpec(spec: WorkflowSpec): LayoutResult {
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

  // Build the dagre graph. Left-to-right layered layout matches the original
  // visual convention; node-/edge-sep are tuned to leave room for our 220×88
  // node cards plus the smoothstep edges from React Flow.
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
  const nodes: LayoutNode[] = nodeIds.map((id) => {
    const n = g.node(id);
    // dagre returns the *centre* of the node; React Flow expects the top-left
    // corner. Convert here so the rest of the app can keep treating positions
    // as top-left.
    const x = n.x - NODE_WIDTH / 2;
    const y = n.y - NODE_HEIGHT / 2;
    maxX = Math.max(maxX, x + NODE_WIDTH);
    maxY = Math.max(maxY, y + NODE_HEIGHT);
    return {
      id,
      indexInRank: 0,
      node: spec.nodes[id] as Node,
      rank: 0,
      x,
      y,
    };
  });

  return {
    edges: allEdges,
    height: Math.max(0, maxY),
    nodes,
    width: Math.max(0, maxX),
  };
}

export function nodeCategoryColor(node: Node): { fill: string; stroke: string; text: string } {
  switch (node.type) {
    case 'step':
      return { fill: '#dbeafe', stroke: '#2563eb', text: '#1e3a8a' };
    case 'agent':
      // Indigo to distinguish the declarative agent node from generic steps.
      return { fill: '#e0e7ff', stroke: '#4f46e5', text: '#312e81' };
    case 'mcp':
      // Cyan/teal for the external MCP tool-call node.
      return { fill: '#cffafe', stroke: '#0e7490', text: '#164e63' };
    case 'set':
      return { fill: '#fef3c7', stroke: '#d97706', text: '#78350f' };
    case 'cond':
      return { fill: '#ede9fe', stroke: '#7c3aed', text: '#4c1d95' };
    case 'signal':
      return { fill: '#cffafe', stroke: '#0891b2', text: '#155e75' };
    case 'fanOut':
      return { fill: '#dcfce7', stroke: '#16a34a', text: '#14532d' };
    case 'shell':
    case 'containerStep':
      // Distinct red-orange to signal the elevated-permissions step type at a glance.
      return { fill: '#ffe4e6', stroke: '#e11d48', text: '#881337' };
    case 'terminate':
      return { fill: '#fee2e2', stroke: '#dc2626', text: '#7f1d1d' };
    case 'humanApproval':
    case 'humanDecision':
    case 'humanInput':
    case 'humanReview':
      return { fill: '#fef9c3', stroke: '#ca8a04', text: '#713f12' };
  }
}

export type DiffKind = 'added' | 'removed' | 'changed';

export function diffStrokeColor(kind: DiffKind | undefined): string | null {
  switch (kind) {
    case 'added':
      return '#16a34a';
    case 'removed':
      return '#dc2626';
    case 'changed':
      return '#d97706';
    default:
      return null;
  }
}

export function statusFill(status: string | undefined): string | undefined {
  if (!status) {
    return undefined;
  }
  switch (status) {
    case 'RUNNING':
      return '#3b82f6';
    case 'PASSED':
      return '#16a34a';
    case 'FAILED':
      return '#dc2626';
    case 'SKIPPED':
      return '#9ca3af';
    case 'PENDING':
      return '#a78bfa';
    default:
      return undefined;
  }
}
