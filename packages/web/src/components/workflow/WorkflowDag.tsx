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
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { TOKEN } from '@/lib/palette';
import { adjacentNodeId, type NavDirection } from './dagKeyboardNav';
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
  // Poll refreshes hand us new object identities for `spec` / `statuses` /
  // `diffMarkers` every 3-5s even when their content is unchanged. Keying the
  // memo on serialized content (rather than identity) means a poll with no
  // real change doesn't tear down and rebuild every React Flow node.
  const specKey = JSON.stringify(spec);
  const statusesKey = JSON.stringify(statuses?.byNodeId ?? null);
  const diffKey = JSON.stringify(diffMarkers ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on serialized content so identity-only poll changes don't rebuild the graph
  const initial = useMemo(
    () => specToFlow(spec, { diffMarkers, statuses }),
    [specKey, statusesKey, diffKey]
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

  const containerRef = useRef<HTMLDivElement>(null);

  // Move DOM focus onto a node's React Flow wrapper so focus follows keyboard
  // selection (React Flow tags each wrapper with `data-id`).
  const focusNodeEl = useCallback((id: string) => {
    const el = containerRef.current?.querySelector<HTMLElement>(
      `.react-flow__node[data-id="${CSS.escape(id)}"]`
    );
    el?.focus();
  }, []);

  // Keyboard graph traversal: arrows walk the edges, Home jumps to the entry
  // node, Enter/Space opens the anchored node in the inspector. The anchor is
  // the currently focused node (falling back to the selected one), so a
  // keyboard/screen-reader user can traverse the DAG without a pointer.
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const focusedId =
        (document.activeElement as HTMLElement | null)
          ?.closest?.('.react-flow__node')
          ?.getAttribute('data-id') ?? null;
      const anchor = focusedId ?? selectedNodeId ?? null;

      const move = (direction: NavDirection) => {
        const target = adjacentNodeId(anchor, direction, nodes, edges);
        if (target) {
          e.preventDefault();
          onSelect?.(target);
          focusNodeEl(target);
        }
      };

      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          move('next');
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          move('prev');
          break;
        case 'Home':
          move('first');
          break;
        case 'Enter':
        case ' ':
          if (anchor) {
            e.preventDefault();
            onSelect?.(anchor);
          }
          break;
      }
    },
    [nodes, edges, selectedNodeId, onSelect, focusNodeEl]
  );

  return (
    <div
      aria-label="Workflow graph. Use arrow keys to move between steps, Enter to open a step, Home to jump to the start."
      // `role="application"` is intentional here — arrow-key navigation needs
      // raw key events rather than the browser's default roving-tabindex
      // behavior a `role="group"`/list would impose. Individual nodes carry
      // their own descriptive `aria-label` (see specToFlow's `ariaLabel`).
      aria-roledescription="workflow graph"
      className="relative rounded-sm border border-ink-600 bg-ink-900"
      onKeyDown={onKeyDown}
      ref={containerRef}
      role="application"
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
        <Background color={TOKEN.ink600} gap={24} size={1.2} variant={BackgroundVariant.Dots} />
        <MiniMap
          maskColor="rgba(10, 12, 18, 0.85)"
          nodeColor={() => TOKEN.ink700}
          nodeStrokeColor={TOKEN.ink500}
          pannable
          style={{
            background: TOKEN.ink900,
            border: `1px solid ${TOKEN.ink600}`,
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
