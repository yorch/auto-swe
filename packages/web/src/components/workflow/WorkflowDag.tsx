'use client';

/**
 * WorkflowDag — React Flow-based renderer for WorkflowSpec graphs.
 *
 * Preserves the original SVG renderer's prop surface (`spec`, `statuses`,
 * `diffMarkers`, `selectedNodeId`, `onSelect`, `responsive`) so the template-
 * detail, diff, and run viewers can keep importing it unchanged. Adds:
 *   - pan + wheel-zoom
 *   - minimap
 *   - "fit to view" / "actual size" / "+ / −" controls
 *   - per-node multi-port handles for cond / signal / fanOut
 *   - smooth-step edges color-coded by kind
 *
 * For interactive editing, prefer the higher-level <TemplateEditor> wrapper
 * which adds drag-to-create, drag-to-connect, and an inspector rail.
 */

import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Node as RFNode,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo } from 'react';
import { DagNode, type DagNodeData } from './dagNode';
import { specToFlow } from './specToFlow';

export type { DiffKind } from '@/lib/workflowLayout';

export interface DagStatusOverlay {
  byNodeId: Record<string, { status: string; attempt: number } | undefined>;
}

interface Props {
  spec: WorkflowSpec;
  statuses?: DagStatusOverlay;
  diffMarkers?: Record<string, import('@/lib/workflowLayout').DiffKind>;
  selectedNodeId?: string | null;
  onSelect?: (id: string | null) => void;
  /** Kept for API compatibility — React Flow is always responsive. */
  responsive?: boolean;
  /** Container height. Defaults to 480px so the diagram has room to breathe. */
  height?: number | string;
}

const NODE_TYPES = { dag: DagNode };

function InnerDag({ spec, statuses, diffMarkers, selectedNodeId, onSelect, height }: Props) {
  const initial = useMemo(
    () => specToFlow(spec, { diffMarkers, statuses }),
    [spec, statuses, diffMarkers]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode<DagNodeData>>(initial.nodes);
  const [edges, , onEdgesChange] = useEdgesState(initial.edges);

  // Reflect external spec / overlay changes back into the flow state.
  // Using JSON serialization as the dep is cheap for the workflow sizes
  // we expect (<100 nodes) and avoids deep-equality libraries.
  useEffect(() => {
    setNodes(initial.nodes);
  }, [initial.nodes, setNodes]);

  // Reflect external selection by setting React Flow's `selected` flag.
  const nodesWithSelection = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        selected: n.id === selectedNodeId,
      })),
    [nodes, selectedNodeId]
  );

  return (
    <div
      className="relative rounded-sm border border-ink-600 bg-ink-900"
      style={{ height: height ?? 480 }}
    >
      <ReactFlow
        edges={edges}
        fitView
        fitViewOptions={{ maxZoom: 1.2, minZoom: 0.55, padding: 0.18 }}
        maxZoom={2.5}
        minZoom={0.15}
        nodes={nodesWithSelection}
        nodesConnectable={false}
        nodesDraggable={false}
        nodeTypes={NODE_TYPES}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, n) => onSelect?.(n.id === selectedNodeId ? null : n.id)}
        onNodesChange={onNodesChange}
        onPaneClick={() => onSelect?.(null)}
        proOptions={{ hideAttribution: true }}
        zoomOnDoubleClick={false}
      >
        <Background color="#1f2530" gap={24} size={1.2} variant={BackgroundVariant.Dots} />
        <MiniMap
          maskColor="rgba(7,9,12,0.85)"
          nodeColor={() => '#171c26'}
          nodeStrokeColor="#2a323f"
          pannable
          style={{
            background: '#0b0e13',
            border: '1px solid #1f2530',
          }}
          zoomable
        />
        <Controls
          className="![&>button]:!bg-ink-800 ![&>button]:!border-ink-500 ![&>button]:!text-paper-200"
          showInteractive={false}
        />
      </ReactFlow>
    </div>
  );
}

export function WorkflowDag(props: Props) {
  return (
    <ReactFlowProvider>
      <InnerDag {...props} />
    </ReactFlowProvider>
  );
}
