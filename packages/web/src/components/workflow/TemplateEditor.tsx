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
  useNodesInitialized,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useTokens } from '@/hooks/useTokens';
import { cn, FOCUS_RING, formatCost, plural } from '@/lib/utils';
import { adjacentNodeId, type NavDirection } from './dagKeyboardNav';
import { DagNode, type DagNodeData, handlePortsFor } from './dagNode';
import { useFitFlow } from './fitFlow';
import { FlowChrome } from './flowChrome';
import { makeDefaultNodeFor } from './makeDefaultNode';
import { NodeInspector } from './NodeInspector';
import { NodePalette, PALETTE_MIME, type PaletteDragKind, PaletteDragSchema } from './NodePalette';
import { deleteNodeFromSpec, renameNodeInSpec, setSpecEdge } from './specEdits';
import { specToFlow } from './specToFlow';
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
  /** A save the server rejected; listed beside the live lint results rather than in a separate banner. */
  serverError?: string | null;
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
  serverError,
  actions,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // The outline is a rail beside the canvas, not a replacement for it, so the
  // canvas (and where the author has dragged things) stays mounted.
  const [showOutline, setShowOutline] = useState(false);
  // Below lg the palette is a drawer over the canvas rather than a fixed column.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteRef = useRef<HTMLDivElement>(null);
  const outlineRef = useRef<HTMLElement>(null);
  const inspectorRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const { screenToFlowPosition } = useReactFlow();

  const stepRegistryByName = useMemo(
    () => new Map(stepRegistry.map((s) => [s.name, s])),
    [stepRegistry]
  );

  const fit = useFitFlow(spec.entry);
  const nodesInitialized = useNodesInitialized();
  // Once, when the nodes the editor opened with are measured: React Flow's own fit centres a
  // graph too large for the readable floor, cutting off its start. Later edits are the
  // author's to frame, and an empty template has nothing to frame (the first node dropped on
  // it must not zoom the canvas in mid-gesture). Hidden until then so no unframed view paints.
  const openedWithNodes = useRef(Object.keys(spec.nodes).length > 0);
  const fitted = useRef(false);
  const [framed, setFramed] = useState(!openedWithNodes.current);
  useEffect(() => {
    if (openedWithNodes.current && nodesInitialized && !fitted.current) {
      fitted.current = true;
      fit();
      setFramed(true);
    }
  }, [nodesInitialized, fit]);

  const tokens = useTokens();
  const initial = useMemo(() => specToFlow(spec, { editable: true, tokens }), [spec, tokens]);
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode<DagNodeData>>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);

  // Edge colours are literal hex (SVG markers cannot read `var()`), so a theme
  // switch repaints each existing edge in place — positions and selection stay.
  useEffect(() => {
    const fresh = new Map(initial.edges.map((e) => [e.id, e]));
    setEdges((prev) =>
      prev.map((e) => {
        const next = fresh.get(e.id);
        return next
          ? {
              ...e,
              labelBgStyle: next.labelBgStyle,
              labelStyle: next.labelStyle,
              markerEnd: next.markerEnd,
              style: next.style,
            }
          : e;
      })
    );
  }, [initial.edges, setEdges]);

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
  const serverIssues = useMemo(
    () =>
      (serverError ?? '')
        .split(/\n|; /)
        .map((m) => m.trim())
        .filter(Boolean),
    [serverError]
  );

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

  // Below lg the palette, outline and inspector are overlays on the canvas, so
  // opening one moves focus into it, and Escape closes it again.
  const paletteTriggerRef = useRef<HTMLElement | null>(null);
  const outlineTriggerRef = useRef<HTMLElement | null>(null);
  const inspectorTriggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (paletteOpen) {
      paletteTriggerRef.current = rememberTrigger();
      focusFirst(paletteRef.current);
    } else {
      restoreTrigger(paletteTriggerRef);
    }
  }, [paletteOpen]);
  useEffect(() => {
    if (showOutline) {
      outlineTriggerRef.current = rememberTrigger();
      focusFirst(outlineRef.current);
    } else {
      restoreTrigger(outlineTriggerRef);
    }
  }, [showOutline]);
  useEffect(() => {
    if (selectedNodeId && overlayMode()) {
      // Selecting a different node keeps the first trigger: closing returns there.
      inspectorTriggerRef.current ??= rememberTrigger();
      focusFirst(inspectorRef.current);
    } else if (!selectedNodeId) {
      restoreTrigger(inspectorTriggerRef);
    }
  }, [selectedNodeId]);
  const handleOverlayKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape' || !overlayMode()) {
      return;
    }
    if (paletteOpen) {
      setPaletteOpen(false);
    } else if (showOutline) {
      setShowOutline(false);
    } else if (selectedNodeId) {
      onSelect(null);
    } else {
      return;
    }
    event.stopPropagation();
  };

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
    <div className="flex h-[calc(100vh-180px)] min-h-[560px] flex-col overflow-hidden border-y border-ink-600 bg-ink-900">
      {/* Action bar */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-ink-600 bg-ink-950/60 px-4 py-2">
        <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
          <div className="flex items-baseline gap-1.5">
            <dt className="sr-only">Nodes</dt>
            <dd className="text-paper-200 tabular-nums">
              {plural(Object.keys(spec.nodes).length, 'node')}
            </dd>
          </div>
          <div className="flex min-w-0 items-baseline gap-1.5">
            <dt className="text-paper-500">Starts at</dt>
            <dd className="truncate font-mono text-xs text-ember-300">{spec.entry}</dd>
          </div>
          {costEstimateUsd != null && costEstimateUsd > 0 && (
            <div
              className="flex items-baseline gap-1.5"
              title="Estimated from each agent's model price"
            >
              <dt className="text-paper-500">Est.</dt>
              <dd className="text-paper-200 tabular-nums">{formatCost(costEstimateUsd)}/run</dd>
            </div>
          )}
          {observedCostUsd != null && (
            <div className="flex items-baseline gap-1.5" title="Average over the last 30 days">
              <dt className="text-paper-500">Observed</dt>
              <dd className="text-paper-200 tabular-nums">{formatCost(observedCostUsd)}/run</dd>
            </div>
          )}
        </dl>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            aria-expanded={paletteOpen}
            className="lg:hidden"
            onClick={() => {
              setPaletteOpen((v) => !v);
              // One overlay at a time below lg.
              setShowOutline(false);
            }}
            size="sm"
            variant="secondary"
          >
            <Icon name="plus" size={13} />
            Add node
          </Button>
          <Button
            aria-pressed={showOutline}
            className={cn(showOutline && 'border-ember-400/50 bg-ember-400/10 text-ember-300')}
            onClick={() => {
              setShowOutline((v) => !v);
              setPaletteOpen(false);
            }}
            size="sm"
            variant="ghost"
          >
            <Icon name="list" size={13} />
            Outline
          </Button>
          {actions}
        </div>
      </div>

      {parseError && (
        <Alert className="rounded-none border-x-0 border-t-0 font-mono text-xs">{parseError}</Alert>
      )}

      {(issues.length > 0 || serverIssues.length > 0) && (
        <details
          className="group border-b border-ink-600 bg-ink-800/60 px-4 py-2 text-xs"
          open={lint.errors.length > 0 || serverIssues.length > 0}
        >
          <summary
            className={cn(
              'flex cursor-pointer list-none items-center gap-1.5 rounded-sm text-paper-300 select-none [&::-webkit-details-marker]:hidden',
              FOCUS_RING
            )}
          >
            <Icon
              className="text-paper-500 transition-transform group-open:rotate-90"
              name="chevronRight"
              size={12}
            />
            <Icon
              className={
                lint.errors.length > 0 || serverIssues.length > 0
                  ? 'text-brick-400'
                  : 'text-amber-400'
              }
              name="warning"
              size={13}
            />
            {serverIssues.length > 0 && (
              <span className="text-brick-400">
                Save rejected: {serverIssues.length} problem{serverIssues.length === 1 ? '' : 's'}
              </span>
            )}
            {serverIssues.length > 0 && issues.length > 0 && ' · '}
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
          <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto pl-5">
            {serverIssues.map((message) => (
              <li className="text-paper-300" key={`server:${message}`}>
                <span className="font-medium text-brick-400">Server:</span> {message}
              </li>
            ))}
            {issues.map((issue) => (
              <li key={`${issue.code}:${issue.nodeId ?? ''}:${issue.field ?? ''}:${issue.message}`}>
                <button
                  className={cn(
                    'rounded-sm text-left text-paper-300 hover:text-paper-100 disabled:hover:text-paper-300',
                    FOCUS_RING
                  )}
                  disabled={!issue.nodeId || !spec.nodes[issue.nodeId]}
                  onClick={() => issue.nodeId && onSelect(issue.nodeId)}
                  type="button"
                >
                  <span
                    className={cn(
                      'font-mono text-[11px]',
                      issue.severity === 'error' ? 'text-brick-400' : 'text-amber-400'
                    )}
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

      {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape only closes the overlays inside */}
      <div
        className="relative flex min-h-0 flex-1 overflow-hidden"
        onKeyDown={handleOverlayKeyDown}
        ref={wrapperRef}
      >
        <div
          className={cn(
            'z-20 h-full shadow-xl lg:static lg:block lg:shadow-none',
            paletteOpen ? 'absolute inset-y-0 left-0 block' : 'hidden'
          )}
          ref={paletteRef}
        >
          <NodePalette
            onAdd={(...args) => {
              handlePaletteAdd(...args);
              setPaletteOpen(false);
            }}
            steps={stepRegistry}
          />
        </div>

        {showOutline && (
          <aside
            aria-label="Outline"
            className="absolute inset-y-0 left-0 z-10 flex w-72 max-w-full shrink-0 flex-col border-r border-ink-600 bg-ink-900 shadow-xl lg:static lg:shadow-none"
            ref={outlineRef}
            tabIndex={-1}
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
          className={`relative min-w-0 flex-1 bg-ink-900 ${framed ? '' : 'opacity-0'}`}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          ref={canvasRef}
          role="application"
        >
          <ReactFlow
            connectionLineStyle={{ stroke: 'var(--color-ember-400)', strokeWidth: 2 }}
            deleteKeyCode="Delete"
            edges={edges}
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
            <FlowChrome onFit={fit} />
          </ReactFlow>
        </div>

        {/* Inspector: a column from lg up; below it, a sheet over the canvas while a node is selected. */}
        <div
          className={cn(
            'z-20 h-full max-w-full flex-col shadow-xl lg:static lg:flex lg:shadow-none [&>aside]:min-h-0 [&>aside]:max-w-full [&>aside]:flex-1',
            selectedNode ? 'absolute inset-y-0 right-0 flex' : 'hidden'
          )}
          ref={inspectorRef}
        >
          {selectedNode && (
            <div className="flex justify-end border-b border-ink-600 border-l bg-ink-950 px-3 py-1.5 lg:hidden">
              <Button onClick={() => onSelect(null)} size="sm" variant="ghost">
                <Icon name="close" size={13} />
                Close inspector
              </Button>
            </div>
          )}
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
    </div>
  );
}

/** The element that had focus when an overlay opened, so closing can give focus back. */
function rememberTrigger(): HTMLElement | null {
  const el = document.activeElement;
  return el instanceof HTMLElement && el !== document.body ? el : null;
}

/** Returns focus to the remembered trigger once its overlay closed, if it is still on the page. */
function restoreTrigger(ref: { current: HTMLElement | null }) {
  const el = ref.current;
  ref.current = null;
  if (el?.isConnected) {
    el.focus();
  }
}

/** Moves focus to the first control inside an overlay, or the overlay itself. */
function focusFirst(container: HTMLElement | null) {
  const target = container?.querySelector<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  (target ?? container)?.focus();
}

/** Below lg the side panels are overlays on the canvas. */
function overlayMode() {
  return !window.matchMedia('(min-width: 1024px)').matches;
}
