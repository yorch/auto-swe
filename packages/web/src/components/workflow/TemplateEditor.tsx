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
  formatValidationIssue,
  nodeEdges,
  readNodeEdge,
  setNodeEdge,
  validateSpec,
} from '@auto-swe/shared/workflow';
import {
  type Connection,
  type EdgeChange,
  ReactFlow,
  ReactFlowProvider,
  type Node as RFNode,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { TOKEN } from '@/lib/palette';
import { formatCost } from '@/lib/utils';
import { adjacentNodeId, type NavDirection } from './dagKeyboardNav';
import { DagNode, type DagNodeData, handlePortsFor } from './dagNode';
import { FlowChrome } from './flowChrome';
import { makeDefaultNodeFor } from './makeDefaultNode';
import { NodeInspector } from './NodeInspector';
import { NodePalette, PALETTE_MIME, type PaletteDragKind, PaletteDragSchema } from './NodePalette';
import { deleteNodeFromSpec, renameNodeInSpec, setSpecEdge } from './specEdits';
import { FIT_VIEW_OPTIONS, specToFlow } from './specToFlow';
import { WorkflowOutline } from './WorkflowOutline';

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
  // The outline is a rail beside the canvas, not a replacement for it, so the
  // canvas (and where the author has dragged things) stays mounted.
  const [showOutline, setShowOutline] = useState(false);
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
  // starter template load, an inspector edit). We compare by serializing — for
  // <100 nodes the cost is negligible and avoids deep-equality library noise.
  const specSig = useMemo(
    () => `${Object.keys(spec.nodes).join('|')}::${spec.entry}::${JSON.stringify(spec.nodes)}`,
    [spec]
  );
  // The graph's *shape*: which nodes exist, their types, and where every edge
  // goes. Editing a field inside a node leaves it unchanged; adding, removing,
  // retyping or rewiring a node does not.
  const structureSig = useMemo(
    () =>
      JSON.stringify([
        spec.entry,
        Object.entries(spec.nodes).map(([id, n]) => [id, n.type, nodeEdges(n)]),
      ]),
    [spec]
  );
  const seededStructure = useRef(structureSig);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate — reseed flow state only when the spec changes, not on every node-drag.
  useEffect(() => {
    if (seededStructure.current === structureSig) {
      // Same shape: refresh what each node shows but keep where the author put
      // it. Re-running the layout on every keystroke in the inspector threw away
      // every manual drag.
      const fresh = new Map(initial.nodes.map((n) => [n.id, n]));
      setNodes((prev) =>
        prev.map((n) => {
          const next = fresh.get(n.id);
          return next ? { ...n, ariaLabel: next.ariaLabel, data: next.data } : n;
        })
      );
    } else {
      seededStructure.current = structureSig;
      setNodes(initial.nodes);
    }
    setEdges(initial.edges);
  }, [specSig]);

  // Live lint. The save path is advisory and the run-start path hard-gates, so
  // an author only found out a spec was broken after saving it. Pure and cheap.
  const lint = useMemo(() => validateSpec(spec), [spec]);
  const issues = useMemo(() => [...lint.errors, ...lint.warnings], [lint]);

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
      const sourceNode = spec.nodes[c.source];
      if (!sourceNode) {
        return;
      }
      // A handle id is the spec field the edge leaves through — but not always
      // a top-level one, so the write goes through `setNodeEdge` rather than an
      // index assignment.
      const field =
        c.sourceHandle && handlePortsFor(sourceNode).some((p) => p.id === c.sourceHandle)
          ? c.sourceHandle
          : handlePortsFor(sourceNode)[0]?.id;
      if (!field) {
        return;
      }
      onChange({
        ...spec,
        nodes: {
          ...spec.nodes,
          [c.source]: setNodeEdge(sourceNode, field, c.target),
        },
      });
    },
    [spec, onChange]
  );

  /** Palette item → new node in the spec at a screen position. We don't
   *  persist position in the spec (spec is purely logical), but the newly
   *  added node will render at that position for this session because we'll
   *  seed an override in the local React Flow state. */
  const addNodeAt = useCallback(
    (payload: PaletteDragKind, screen: { x: number; y: number }) => {
      const pos = screenToFlowPosition(screen);

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

  /** Drop-from-palette → new node at the cursor position. */
  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const payloadRaw = event.dataTransfer.getData(PALETTE_MIME);
      if (!payloadRaw) {
        return;
      }
      const parsed = PaletteDragSchema.safeParse(JSON.parse(payloadRaw));
      if (!parsed.success) {
        return;
      }
      addNodeAt(parsed.data, { x: event.clientX, y: event.clientY });
    },
    [addNodeAt]
  );

  /** Keyboard add from the palette → new node at the centre of the canvas. */
  const handlePaletteAdd = useCallback(
    (payload: PaletteDragKind) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      addNodeAt(payload, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    },
    [addNodeAt]
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
      // Same grammar as every other edit: the handle id is a spec field name,
      // which for a decision option is not a top-level one. `setSpecEdge` also
      // decides what "cleared" means for a field the schema requires — such a
      // branch reappears pointing at the unresolved-branch placeholder rather
      // than leaving a node that no longer parses.
      let next = spec;
      for (const r of removed) {
        const edge = edges.find((e) => e.id === r.id);
        if (!edge?.sourceHandle) {
          continue;
        }
        const source = next.nodes[edge.source];
        if (!source || readNodeEdge(source, edge.sourceHandle) !== edge.target) {
          continue;
        }
        next = setSpecEdge(next, edge.source, edge.sourceHandle, null);
      }
      if (next !== spec) {
        onChange(next);
      }
    },
    [onEdgesChange, edges, spec, onChange]
  );

  const handleDeleteNode = useCallback(() => {
    if (!selectedNodeId || selectedNodeId === spec.entry) {
      return;
    }
    // Reference repair lives in `specEdits`, driven by the spec's own edge
    // grammar — see that module for why a required edge is retargeted to a
    // placeholder instead of being dropped.
    onChange(deleteNodeFromSpec(spec, selectedNodeId));
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
          move('next');
          break;
        case 'ArrowLeft':
          move('prev');
          break;
        // Up/Down walk the other branches of a cond / fan-out / human gate;
        // Right only ever reaches the topmost one.
        case 'ArrowDown':
          move('nextSibling');
          break;
        case 'ArrowUp':
          move('prevSibling');
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
      const next = renameNodeInSpec(spec, oldId, newId);
      if (next === spec) {
        return;
      }
      onChange(next);
      onSelect(newId);
    },
    [spec, onChange, onSelect]
  );

  const knownGroups = useMemo(
    () => [...new Set(Object.values(spec.nodes).flatMap((n) => (n.group ? [n.group] : [])))],
    [spec]
  );
  const selectedNode = selectedNodeId ? spec.nodes[selectedNodeId] : null;
  const selectedStepMeta =
    selectedNode && selectedNode.type === 'step' ? stepRegistryByName.get(selectedNode.step) : null;

  return (
    <div className="flex h-[calc(100vh-180px)] min-h-[560px] flex-col overflow-hidden rounded-sm border border-ink-600 bg-ink-900">
      {/* Action bar */}
      <div className="flex items-center justify-between gap-4 border-b border-ink-600 px-4 py-2">
        <div className="label-mono flex items-center gap-3">
          <span>nodes</span>
          <span className="tabular text-paper-200">{Object.keys(spec.nodes).length}</span>
          <span className="text-ink-500">·</span>
          <span>first step</span>
          <span className="tabular text-ember-400">{spec.entry}</span>
          {costEstimateUsd != null && costEstimateUsd > 0 && (
            <>
              <span className="text-ink-500">·</span>
              <span>est</span>
              <span className="tabular text-paper-200">{formatCost(costEstimateUsd)}/run</span>
            </>
          )}
          {observedCostUsd != null && (
            <>
              <span className="text-ink-500">·</span>
              <span>observed</span>
              <span className="tabular text-paper-200">{formatCost(observedCostUsd)}/run</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            aria-pressed={showOutline}
            onClick={() => setShowOutline((v) => !v)}
            size="sm"
            variant={showOutline ? 'primary' : 'ghost'}
          >
            Outline
          </Button>
          {actions}
        </div>
      </div>

      {parseError && (
        <Alert className="rounded-none border-x-0 border-t-0 font-mono text-[11px]">
          {parseError}
        </Alert>
      )}

      {issues.length > 0 && (
        <details className="border-b border-ink-600/40 bg-ink-800/60 px-4 py-1.5 font-mono text-[11px]">
          <summary className="cursor-pointer select-none text-paper-400">
            {lint.errors.length > 0 && (
              <span className="text-brick-400">
                {lint.errors.length} error{lint.errors.length === 1 ? '' : 's'}
              </span>
            )}
            {lint.errors.length > 0 && lint.warnings.length > 0 && ' · '}
            {lint.warnings.length > 0 && (
              <span className="text-amber-400">
                {lint.warnings.length} warning{lint.warnings.length === 1 ? '' : 's'}
              </span>
            )}
          </summary>
          <ul className="mt-1.5 max-h-32 space-y-0.5 overflow-y-auto">
            {issues.map((issue) => (
              <li key={`${issue.code}:${issue.nodeId ?? ''}:${issue.field ?? ''}:${issue.message}`}>
                <button
                  className="text-left text-paper-300 hover:text-paper-100"
                  disabled={!issue.nodeId || !spec.nodes[issue.nodeId]}
                  onClick={() => issue.nodeId && onSelect(issue.nodeId)}
                  type="button"
                >
                  <span
                    className={issue.severity === 'error' ? 'text-brick-400' : 'text-amber-400'}
                  >
                    {issue.code}
                  </span>{' '}
                  {formatValidationIssue(issue)}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="flex flex-1 overflow-hidden" ref={wrapperRef}>
        <NodePalette onAdd={handlePaletteAdd} steps={stepRegistry} />

        {showOutline && (
          <aside
            aria-label="Outline"
            className="flex w-72 shrink-0 flex-col border-r border-ink-600 bg-ink-900"
          >
            <WorkflowOutline
              className="flex-1"
              height="100%"
              onSelect={onSelect}
              selectedNodeId={selectedNodeId}
              spec={spec}
            />
          </aside>
        )}

        {/* Canvas — this wrapper is the HTML5 drag-and-drop target; the React Flow
            canvas inside it is the interactive surface. */}
        <div
          aria-label="Workflow editor canvas. Left and right arrows follow the flow, up and down arrows switch between branches, Enter opens a node, Home jumps to the start, Delete removes the selected node."
          className="relative flex-1 bg-ink-900"
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          ref={canvasRef}
          role="application"
        >
          <ReactFlow
            connectionLineStyle={{ stroke: TOKEN.ember400, strokeWidth: 2 }}
            deleteKeyCode="Delete"
            edges={edges}
            fitView
            fitViewOptions={FIT_VIEW_OPTIONS}
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
            <FlowChrome />
          </ReactFlow>
        </div>

        {/* Inspector */}
        <NodeInspector
          allNodeIds={Object.keys(spec.nodes)}
          isEntry={selectedNodeId === spec.entry}
          knownGroups={knownGroups}
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
