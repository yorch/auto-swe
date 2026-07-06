/**
 * Convert a WorkflowSpec into React Flow {nodes, edges} arrays.
 *
 * Initial node positions come from the existing layered `layoutSpec` so the
 * default arrangement matches what the old SVG-based renderer produced. From
 * there, React Flow takes over for pan/zoom/drag. Edge kinds map 1:1 onto
 * React Flow source-handle ids — that's how cond/signal/fanOut multi-output
 * nodes know which port an edge connects from.
 */
import type { Node as SpecNode, WorkflowSpec } from '@auto-swe/shared/workflow';
import type { Edge as RFEdge, Node as RFNode } from '@xyflow/react';
import { type DiffKind, type EdgeKind, layoutSpec } from '@/lib/workflowLayout';
import type { DagNodeData } from './dagNode';

const EDGE_LABEL: Partial<Record<EdgeKind, string>> = {
  onApprove: 'approve',
  onFalse: 'false',
  onReceive: 'signal',
  onReject: 'reject',
  onSubmit: 'submit',
  onTimeout: 'timeout',
  onTrue: 'true',
};

const EDGE_STROKE: Record<EdgeKind, string> = {
  join: '#e26b3c', // ember-400
  next: '#a8a395', // paper-400
  onApprove: '#7ea67a', // moss-400
  onFalse: '#c44a4a', // brick-400
  onReceive: '#85a6c5', // dust-400
  onReject: '#c44a4a', // brick-400
  onSubmit: '#7ea67a', // moss-400
  onTimeout: '#d4a547', // amber-400
  onTrue: '#7ea67a', // moss-400
  subgraph: '#9b8bc4', // violet-400
};

function subLabelFor(node: SpecNode): string | undefined {
  switch (node.type) {
    case 'step':
      return node.step;
    case 'cond':
      return node.expr;
    case 'signal':
      return `signal · ${node.name}`;
    case 'fanOut':
      return `fanOut · ${node.itemKey ?? 'subtask'}`;
    case 'terminate':
      return `→ ${node.status}`;
    case 'set':
      return (
        Object.keys(node.values ?? {})
          .slice(0, 3)
          .join(', ') || undefined
      );
    case 'shell':
      return `shell · ${node.image}`;
    case 'mcp':
      return `mcp · ${node.tool}`;
    case 'containerStep':
      return `container · ${node.image}`;
    case 'humanApproval':
    case 'humanDecision':
    case 'humanInput':
    case 'humanReview':
      return node.title || undefined;
  }
}

interface ConvertOpts {
  statuses?: { byNodeId: Record<string, { status: string; attempt: number } | undefined> };
  diffMarkers?: Record<string, DiffKind>;
  editable?: boolean;
}

export function specToFlow(
  spec: WorkflowSpec,
  opts: ConvertOpts = {}
): { nodes: RFNode<DagNodeData>[]; edges: RFEdge[] } {
  const layout = layoutSpec(spec);

  const nodes: RFNode<DagNodeData>[] = layout.nodes.map((n) => {
    const subLabel = subLabelFor(n.node);
    const status = opts.statuses?.byNodeId[n.id];
    // Descriptive label for React Flow's focusable node wrapper, so keyboard /
    // screen-reader traversal announces "<type> node <id>[, <subLabel>][,
    // status <status>]" instead of React Flow's generic default.
    const ariaLabel = [
      `${n.node.type} node ${n.id}`,
      subLabel,
      status ? `status ${status.status.toLowerCase()}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    return {
      ariaLabel,
      data: {
        diff: opts.diffMarkers?.[n.id],
        editable: opts.editable ?? false,
        node: n.node,
        status,
        subLabel,
      },
      id: n.id,
      position: { x: n.x, y: n.y },
      type: 'dag',
    };
  });

  const edges: RFEdge[] = layout.edges.map((e) => {
    const color = EDGE_STROKE[e.kind];
    const dashed = opts.diffMarkers?.[e.from] === 'removed';
    const label = EDGE_LABEL[e.kind];
    return {
      animated: opts.statuses?.byNodeId[e.from]?.status === 'RUNNING',
      id: `${e.from}-${e.kind}-${e.to}`,
      ...(label && {
        label,
        labelBgPadding: [4, 2] as [number, number],
        labelBgStyle: { fill: '#0b0e13', fillOpacity: 0.85 },
        labelStyle: {
          fill: color,
          fontFamily: 'monospace',
          fontSize: 9,
          fontWeight: 500,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        },
      }),
      markerEnd: {
        color,
        height: 16,
        type: 'arrowclosed',
        width: 16,
      },
      source: e.from,
      sourceHandle: e.kind,
      style: {
        stroke: color,
        strokeDasharray: dashed ? '4 4' : undefined,
        strokeWidth: 1.5,
      },
      target: e.to,
      targetHandle: 'in',
      type: 'smoothstep',
    } satisfies RFEdge;
  });

  return { edges, nodes };
}

/** Re-run auto-layout on the current node set — used by the "tidy" button in
 *  the editor after the user has dragged nodes around. */
export function relayoutNodes(spec: WorkflowSpec): Record<string, { x: number; y: number }> {
  const layout = layoutSpec(spec);
  const out: Record<string, { x: number; y: number }> = {};
  for (const n of layout.nodes) {
    out[n.id] = { x: n.x, y: n.y };
  }
  return out;
}
