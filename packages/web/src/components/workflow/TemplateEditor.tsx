'use client';

/**
 * TemplateEditor — visual workflow spec editor.
 *
 * Wraps React Flow with:
 *  - Left rail: <NodePalette> with primitives + step registry (drag onto canvas)
 *  - Centre:   ReactFlow canvas with drag-to-create + drag-to-connect
 *  - Right rail: schema-aware <NodeInspector> for the selected node
 *
 * The single source of truth is the `spec` prop. Edits emit through `onChange`
 * — the parent controls validation, save flow, and version management.
 * Initial node positions come from `layoutSpec`; the user can drag to refine
 * for the session but positions are not persisted in the spec (no schema
 * change required).
 */

import type { Node as SpecNode, StepMetadata, WorkflowSpec } from '@auto-swe/shared/workflow';
import {
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type EdgeChange,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Node as RFNode,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { adjacentNodeId, type NavDirection } from './dagKeyboardNav';
import { DagNode, type DagNodeData, type HandleKind, handleKindsFor } from './dagNode';
import { makeDefaultNodeFor } from './makeDefaultNode';
import { NodeInspector } from './NodeInspector';
import { NodePalette, PALETTE_MIME, type PaletteDragKind } from './NodePalette';
import { specToFlow } from './specToFlow';

const NODE_TYPES = { dag: DagNode };

interface Props {
  spec: WorkflowSpec;
  stepRegistry: StepMetadata[];
  selectedNodeId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (next: WorkflowSpec) => void;
  costEstimateUsd?: number | null;
  observedCostUsd?: number | null;
  parseError?: string | null;
  /** Action bar shown above the canvas — parent supplies Save/Cancel CTAs. */
  actions?: React.ReactNode;
}

export function TemplateEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <EditorInner {...props} />
    </ReactFlowProvider>
  );
}

function EditorInner({
  spec,
  stepRegistry,
  selectedNodeId,
  onSelect,
  onChange,
  costEstimateUsd,
  observedCostUsd,
  parseError,
  actions,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const { screenToFlowPosition } = useReactFlow();

  const stepRegistryByName = useMemo(
    () => new Map(stepRegistry.map((s) => [s.name, s])),
    [stepRegistry]
  );

  const initial = useMemo(() => specToFlow(spec, { editable: true }), [spec]);
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode<DagNodeData>>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);

  // Resync when the parent spec changes (e.g. after Save, version switch,
  // starter template load). We compare ids cheaply by serializing them — for
  // <100 nodes the cost is negligible and avoids deep-equality library noise.
  const specSig = useMemo(
    () => `${Object.keys(spec.nodes).join('|')}::${spec.entry}::${JSON.stringify(spec.nodes)}`,
    [spec]
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate — reseed flow state only when the structural spec changes, not on every node-drag.
  useEffect(() => {
    setNodes(initial.nodes);
    setEdges(initial.edges);
  }, [specSig]);

  const nodesWithSelection = useMemo(
    () => nodes.map((n) => ({ ...n, selected: n.id === selectedNodeId })),
    [nodes, selectedNodeId]
  );

  /** When the user drag-connects two handles, mutate the spec to set the
   *  source node's outgoing field for that handle kind. */
  const handleConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || !c.sourceHandle) {
        return;
      }
      const handleKind = c.sourceHandle as HandleKind;
      const sourceNode = spec.nodes[c.source];
      if (!sourceNode) {
        return;
      }
      const valid = handleKindsFor(sourceNode);
      if (!valid.includes(handleKind)) {
        return;
      }
      const patched = {
        ...(sourceNode as unknown as Record<string, unknown>),
        [handleKind]: c.target,
      };
      onChange({
        ...spec,
        nodes: {
          ...spec.nodes,
          [c.source]: patched as WorkflowSpec['nodes'][string],
        },
      });
    },
    [spec, onChange]
  );

  /** Drop-from-palette → new node in the spec at the cursor position. We
   *  don't persist position in the spec (spec is purely logical), but the
   *  newly added node will render at the drop position for this session
   *  because we'll seed an override in the local React Flow state. */
  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const payloadRaw = event.dataTransfer.getData(PALETTE_MIME);
      if (!payloadRaw) {
        return;
      }
      let payload: PaletteDragKind;
      try {
        payload = JSON.parse(payloadRaw) as PaletteDragKind;
      } catch {
        return;
      }

      const pos = screenToFlowPosition({ x: event.clientX, y: event.clientY });

      const existingIds = Object.keys(spec.nodes);
      const baseName =
        payload.kind === 'step'
          ? payload.step.replace(/[^a-zA-Z0-9]/g, '_')
          : payload.kind === 'primitive'
            ? payload.nodeType
            : 'node';
      let newId = baseName;
      let counter = 2;
      while (existingIds.includes(newId)) {
        newId = `${baseName}_${counter++}`;
      }

      const newNode: SpecNode = makeDefaultNodeFor(payload);
      onChange({
        ...spec,
        nodes: { ...spec.nodes, [newId]: newNode },
      });
      onSelect(newId);

      // Override the layout-assigned position for the new node so it lands
      // where the user dropped it. This is session-local: a structural spec
      // change resets via the effect above.
      requestAnimationFrame(() => {
        setNodes((prev) => prev.map((n) => (n.id === newId ? { ...n, position: pos } : n)));
      });
    },
    [spec, onChange, onSelect, screenToFlowPosition, setNodes]
  );

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  /** Delete handles edge removal — keeping the spec field cleared. */
  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      onEdgesChange(changes);
      const removed = changes.filter(
        (c): c is Extract<EdgeChange, { type: 'remove' }> => c.type === 'remove'
      );
      if (removed.length === 0) {
        return;
      }
      const nextNodes = { ...spec.nodes };
      let mutated = false;
      for (const r of removed) {
        const edge = edges.find((e) => e.id === r.id);
        if (!edge?.sourceHandle) {
          continue;
        }
        const source = nextNodes[edge.source];
        if (!source) {
          continue;
        }
        const patched = { ...(source as unknown as Record<string, unknown>) };
        if (patched[edge.sourceHandle] === edge.target) {
          delete patched[edge.sourceHandle];
          nextNodes[edge.source] = patched as WorkflowSpec['nodes'][string];
          mutated = true;
        }
      }
      if (mutated) {
        onChange({ ...spec, nodes: nextNodes });
      }
    },
    [onEdgesChange, edges, spec, onChange]
  );

  const handleDeleteNode = useCallback(() => {
    if (!selectedNodeId || selectedNodeId === spec.entry) {
      return;
    }
    const { [selectedNodeId]: _removed, ...rest } = spec.nodes;
    // Clear any references pointing at the deleted node.
    const cleaned = Object.fromEntries(
      Object.entries(rest).map(([nid, node]) => {
        const patched = { ...(node as unknown as Record<string, unknown>) };
        for (const k of [
          'next',
          'onTrue',
          'onFalse',
          'onReceive',
          'onTimeout',
          'subgraph',
          'join',
        ] as const) {
          if (patched[k] === selectedNodeId) {
            delete patched[k];
          }
        }
        return [nid, patched];
      })
    ) as WorkflowSpec['nodes'];
    onChange({ ...spec, nodes: cleaned });
    onSelect(null);
  }, [selectedNodeId, spec, onChange, onSelect]);

  // Delete the selected node when Delete/Backspace is pressed while a canvas
  // element (not an input/textarea) holds focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') {
        return;
      }
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return;
      }
      handleDeleteNode();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleDeleteNode]);

  // Move DOM focus onto a node's React Flow wrapper so focus follows keyboard
  // selection (React Flow tags each wrapper with `data-id`).
  const focusNodeEl = useCallback((id: string) => {
    const el = canvasRef.current?.querySelector<HTMLElement>(
      `.react-flow__node[data-id="${CSS.escape(id)}"]`
    );
    el?.focus();
  }, []);

  // Keyboard graph traversal for the editor — parity with the read-only viewer.
  // Arrows walk the edges, Home jumps to the entry node, Enter opens the focused
  // node in the inspector. Attached in the CAPTURE phase so it preempts React
  // Flow's native arrow-key node nudge (positions are session-only and not
  // persisted, so overriding the nudge costs nothing). Space is deliberately
  // left to React Flow (its default pan-activation key).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return;
      }
      const focusedId =
        (document.activeElement as HTMLElement | null)
          ?.closest?.('.react-flow__node')
          ?.getAttribute('data-id') ?? null;
      const anchor = focusedId ?? selectedNodeId ?? null;
      const move = (direction: NavDirection) => {
        const target = adjacentNodeId(anchor, direction, nodes, edges);
        if (target) {
          e.preventDefault();
          e.stopPropagation();
          onSelect(target);
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
          // Only when a node holds focus, so Enter on a Controls button still works.
          if (focusedId) {
            e.preventDefault();
            e.stopPropagation();
            onSelect(focusedId);
          }
          break;
      }
    };
    el.addEventListener('keydown', onKey, { capture: true });
    return () => el.removeEventListener('keydown', onKey, { capture: true });
  }, [nodes, edges, selectedNodeId, onSelect, focusNodeEl]);

  const handleRename = useCallback(
    (oldId: string, newId: string) => {
      if (!newId || oldId === newId || spec.nodes[newId]) {
        return;
      }
      const renamed: WorkflowSpec['nodes'] = {};
      for (const [k, v] of Object.entries(spec.nodes)) {
        const patched = { ...(v as unknown as Record<string, unknown>) };
        for (const f of [
          'next',
          'onTrue',
          'onFalse',
          'onReceive',
          'onTimeout',
          'subgraph',
          'join',
        ] as const) {
          if (patched[f] === oldId) {
            patched[f] = newId;
          }
        }
        renamed[k === oldId ? newId : k] = patched as WorkflowSpec['nodes'][string];
      }
      onChange({
        ...spec,
        entry: spec.entry === oldId ? newId : spec.entry,
        nodes: renamed,
      });
      onSelect(newId);
    },
    [spec, onChange, onSelect]
  );

  const selectedNode = selectedNodeId ? spec.nodes[selectedNodeId] : null;
  const selectedStepMeta =
    selectedNode && selectedNode.type === 'step' ? stepRegistryByName.get(selectedNode.step) : null;

  return (
    <div className="flex h-[calc(100vh-180px)] min-h-[560px] flex-col overflow-hidden rounded-sm border border-ink-600 bg-ink-900">
      {/* Action bar */}
      <div className="flex items-center justify-between gap-4 border-b border-ink-600 px-4 py-2">
        <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
          <span>nodes</span>
          <span className="tabular text-paper-200">{Object.keys(spec.nodes).length}</span>
          <span className="text-ink-500">·</span>
          <span>entry</span>
          <span className="tabular text-ember-400">{spec.entry}</span>
          {costEstimateUsd != null && costEstimateUsd > 0 && (
            <>
              <span className="text-ink-500">·</span>
              <span>est</span>
              <span className="tabular text-paper-200">${costEstimateUsd.toFixed(2)}/run</span>
            </>
          )}
          {observedCostUsd != null && (
            <>
              <span className="text-ink-500">·</span>
              <span>observed</span>
              <span className="tabular text-paper-200">${observedCostUsd.toFixed(2)}/run</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">{actions}</div>
      </div>

      {parseError && (
        <div className="border-b border-ink-600 bg-brick-400/10 px-4 py-2 font-mono text-[11px] text-brick-400">
          ! {parseError}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden" ref={wrapperRef}>
        <NodePalette steps={stepRegistry} />

        {/* Canvas — this wrapper is the HTML5 drag-and-drop target; the React Flow
            canvas inside it is the interactive surface. */}
        <div
          aria-label="Workflow editor canvas. Use arrow keys to move between nodes, Enter to open a node, Home to jump to the start, Delete to remove the selected node."
          className="relative flex-1 bg-ink-900"
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          ref={canvasRef}
          role="application"
        >
          <ReactFlow
            connectionLineStyle={{ stroke: '#e26b3c', strokeWidth: 2 }}
            edges={edges}
            fitView
            fitViewOptions={{ maxZoom: 1.2, minZoom: 0.55, padding: 0.18 }}
            maxZoom={2.5}
            minZoom={0.15}
            nodes={nodesWithSelection}
            nodesConnectable
            nodesDraggable
            nodeTypes={NODE_TYPES}
            onConnect={handleConnect}
            onEdgesChange={handleEdgesChange}
            onNodeClick={(_, n) => onSelect(n.id === selectedNodeId ? null : n.id)}
            onNodesChange={onNodesChange}
            onPaneClick={() => onSelect(null)}
            proOptions={{ hideAttribution: true }}
            zoomOnDoubleClick={false}
          >
            <Background color="#1f2530" gap={24} size={1.2} variant={BackgroundVariant.Dots} />
            <MiniMap
              maskColor="rgba(7,9,12,0.85)"
              nodeColor={() => '#171c26'}
              nodeStrokeColor="#2a323f"
              pannable
              style={{ background: '#0b0e13', border: '1px solid #1f2530' }}
              zoomable
            />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        {/* Inspector */}
        <NodeInspector
          allNodeIds={Object.keys(spec.nodes)}
          isEntry={selectedNodeId === spec.entry}
          node={selectedNode}
          nodeId={selectedNodeId}
          onChangeNode={(next) => {
            if (!selectedNodeId) {
              return;
            }
            onChange({
              ...spec,
              nodes: { ...spec.nodes, [selectedNodeId]: next },
            });
          }}
          onDelete={handleDeleteNode}
          onRename={handleRename}
          stepMeta={selectedStepMeta}
          stepRegistry={stepRegistry}
        />
      </div>
    </div>
  );
}
