/**
 * Lightweight layered layout for WorkflowSpec DAGs.
 *
 * Computes (x, y) coordinates for every node using a shortest-path BFS rank
 * assignment from the entry node, with index-within-rank for x. Back-edges
 * (cond → onTrue pointing to an already-ranked ancestor) are kept in the edge
 * list but do not affect ranks. Disconnected nodes are placed in a trailing
 * column (one past the deepest ranked node) so they don't crowd the entry
 * column. This avoids pulling in a real graph-layout dep like dagre while
 * still producing readable diagrams for the workflow sizes we expect
 * (<100 nodes).
 */
import type { Node, WorkflowSpec } from '@auto-swe/shared/workflow';

export type EdgeKind =
  | 'next'
  | 'onTrue'
  | 'onFalse'
  | 'onReceive'
  | 'onTimeout'
  | 'subgraph'
  | 'join';

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
  rank: number;
  indexInRank: number;
}

export interface LayoutResult {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}

export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 56;
export const RANK_X_SPACING = 240;
export const NODE_Y_SPACING = 80;

function collectEdges(node: Node, id: string): LayoutEdge[] {
  const edges: LayoutEdge[] = [];
  switch (node.type) {
    case 'step':
    case 'set':
      if (node.next) edges.push({ from: id, kind: 'next', to: node.next });
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
  }
  return edges;
}

export function layoutSpec(spec: WorkflowSpec): LayoutResult {
  const nodeIds = Object.keys(spec.nodes);
  if (nodeIds.length === 0) {
    return { edges: [], height: 0, nodes: [], width: 0 };
  }

  const allEdges: LayoutEdge[] = [];
  for (const id of nodeIds) {
    for (const e of collectEdges(spec.nodes[id] as Node, id)) {
      // Drop edges to unknown nodes (shouldn't happen with a parsed spec, but
      // be defensive — partially-edited specs in the editor may dangle).
      if (e.to in spec.nodes) allEdges.push(e);
    }
  }

  // BFS rank assignment from the entry. Cycles are tolerated: a back-edge
  // visits a node whose rank is already set, so we skip it.
  const edgesByFrom = new Map<string, LayoutEdge[]>();
  for (const e of allEdges) {
    const bucket = edgesByFrom.get(e.from);
    if (bucket) bucket.push(e);
    else edgesByFrom.set(e.from, [e]);
  }
  const rank = new Map<string, number>();
  rank.set(spec.entry, 0);
  const queue: string[] = [spec.entry];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const r = rank.get(id) ?? 0;
    for (const e of edgesByFrom.get(id) ?? []) {
      if (!rank.has(e.to)) {
        rank.set(e.to, r + 1);
        queue.push(e.to);
      }
    }
  }
  // Park any disconnected nodes in a trailing column past the deepest ranked
  // node so they don't crowd the entry column.
  let deepest = 0;
  for (const r of rank.values()) deepest = Math.max(deepest, r);
  for (const id of nodeIds) {
    if (!rank.has(id)) rank.set(id, deepest + 1);
  }

  // Group by rank, then assign indexInRank deterministically by id.
  const byRank = new Map<number, string[]>();
  for (const id of nodeIds) {
    const r = rank.get(id) as number;
    if (!byRank.has(r)) byRank.set(r, []);
    (byRank.get(r) as string[]).push(id);
  }
  for (const ids of byRank.values()) ids.sort();

  const nodes: LayoutNode[] = [];
  let maxRank = 0;
  let maxIndex = 0;
  for (const [r, ids] of byRank.entries()) {
    maxRank = Math.max(maxRank, r);
    ids.forEach((id, i) => {
      maxIndex = Math.max(maxIndex, i);
      nodes.push({
        id,
        indexInRank: i,
        node: spec.nodes[id] as Node,
        rank: r,
        x: r * RANK_X_SPACING,
        y: i * (NODE_HEIGHT + NODE_Y_SPACING),
      });
    });
  }

  return {
    edges: allEdges,
    height: (maxIndex + 1) * (NODE_HEIGHT + NODE_Y_SPACING),
    nodes,
    width: (maxRank + 1) * RANK_X_SPACING + NODE_WIDTH,
  };
}

export function nodeCategoryColor(node: Node): { fill: string; stroke: string; text: string } {
  switch (node.type) {
    case 'step':
      return { fill: '#dbeafe', stroke: '#2563eb', text: '#1e3a8a' };
    case 'set':
      return { fill: '#fef3c7', stroke: '#d97706', text: '#78350f' };
    case 'cond':
      return { fill: '#ede9fe', stroke: '#7c3aed', text: '#4c1d95' };
    case 'signal':
      return { fill: '#cffafe', stroke: '#0891b2', text: '#155e75' };
    case 'fanOut':
      return { fill: '#dcfce7', stroke: '#16a34a', text: '#14532d' };
    case 'terminate':
      return { fill: '#fee2e2', stroke: '#dc2626', text: '#7f1d1d' };
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
  if (!status) return undefined;
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
