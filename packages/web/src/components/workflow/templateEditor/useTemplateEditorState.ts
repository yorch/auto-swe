import type { Node as SpecNode, WorkflowSpec } from '@auto-swe/shared/workflow';
import { nodeEdges, readNodeEdge, setNodeEdge, validateSpec } from '@auto-swe/shared/workflow';
import {
  type Connection,
  type EdgeChange,
  type Node as RFNode,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTokens } from '@/hooks/useTokens';
import { useValidateWorkflow } from '@/hooks/useValidateWorkflow';
import { ApiError } from '@/lib/api';
import { errMsg } from '@/lib/errors';
import { schemaIssues } from '@/lib/specSchemaIssues';
import { adjacentNodeId, type NavDirection } from '../dagKeyboardNav';
import { type DagNodeData, handlePortsFor } from '../dagNode';
import { useFitFlow } from '../fitFlow';
import { makeDefaultNodeFor } from '../makeDefaultNode';
import { PALETTE_MIME, type PaletteDragKind, PaletteDragSchema } from '../NodePalette';
import { deleteNodeFromSpec, renameNodeInSpec, setSpecEdge } from '../specEdits';
import { specToFlow } from '../specToFlow';
import { type CheckSnapshot, newServerIssues, type ServerCheck } from './checkHelpers';
import { focusFirst, overlayMode, rememberTrigger, restoreTrigger } from './overlayFocus';
import type { TemplateEditorProps } from './types';

/**
 * All of the editor's state, effects and handlers. Must run inside a `ReactFlowProvider`
 * (it reads the flow instance), and its hook order is fixed: nothing here is conditional.
 */
export function useTemplateEditorState({
  spec,
  stepRegistry,
  selectedNodeId,
  onSelect,
  onChange,
  serverError,
  templateId,
  teamId,
  baseVersion,
}: TemplateEditorProps) {
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
  const lint = useMemo(() => {
    const report = validateSpec(spec);
    return { errors: [...schemaIssues(spec), ...report.errors], warnings: report.warnings };
  }, [spec]);
  const issues = useMemo(() => [...lint.errors, ...lint.warnings], [lint]);
  // "Check workflow": a snapshot of the live lint at the click, tied to the spec it was taken on so
  // an edit makes the result stale (and hides it) instead of leaving a wrong "no problems". The
  // live lint above stays client-only; the server is asked once per click, never per keystroke.
  const [checked, setChecked] = useState<CheckSnapshot | null>(null);
  const issuesRef = useRef<HTMLDetailsElement>(null);
  const issuesSummaryRef = useRef<HTMLElement>(null);
  // The spec a server check is running for. A click on the same spec waits for it; an edit since
  // then is a different question and starts its own.
  const checkInFlight = useRef<WorkflowSpec | null>(null);
  const seqRef = useRef(0);
  const { mutateAsync: validateAsync } = useValidateWorkflow();
  const checkResult = checked && checked.spec === spec ? checked : null;
  // Server findings the editor's own lint did not already report.
  const serverExtra = useMemo(
    () =>
      checkResult?.server.state === 'done'
        ? newServerIssues(checkResult.server.issues, issues)
        : [],
    [checkResult, issues]
  );
  const shownErrors = lint.errors.length + serverExtra.filter((i) => i.severity === 'error').length;
  const shownWarnings =
    lint.warnings.length + serverExtra.filter((i) => i.severity !== 'error').length;
  const openIssuesPanel = useCallback(() => {
    // A warnings-only panel starts collapsed: open it and move focus into it.
    if (issuesRef.current) {
      issuesRef.current.open = true;
    }
    issuesSummaryRef.current?.focus();
  }, []);
  const [revealIssues, setRevealIssues] = useState(0);
  useEffect(() => {
    if (revealIssues > 0) {
      openIssuesPanel();
    }
  }, [revealIssues, openIssuesPanel]);
  const runCheck = useCallback(() => {
    if (checkInFlight.current === spec) {
      return;
    }
    checkInFlight.current = spec;
    seqRef.current += 1;
    const seq = seqRef.current;
    const clientIssues = [...lint.errors, ...lint.warnings];
    setChecked({ seq, server: { state: 'pending' }, spec });
    if (clientIssues.length > 0) {
      openIssuesPanel();
    }
    validateAsync({
      spec,
      ...(templateId ? { templateId } : {}),
      ...(teamId ? { teamId } : {}),
      ...(templateId && baseVersion ? { baseVersion } : {}),
    })
      .then((res): ServerCheck => {
        if (!res || !Array.isArray(res.issues)) {
          return { reason: 'the server sent an unexpected answer', state: 'failed' };
        }
        return { issues: res.issues, state: 'done' };
      })
      .catch(
        (err: unknown): ServerCheck => ({
          reason:
            err instanceof ApiError && err.status === 403
              ? 'you are not permitted to run it'
              : errMsg(err, 'the request failed'),
          state: 'failed',
        })
      )
      .then((server) => {
        if (seqRef.current === seq) {
          checkInFlight.current = null;
        }
        setChecked((prev) => (prev && prev.seq === seq ? { ...prev, server } : prev));
        // Findings only the server has land after the click: bring the author to them, but only
        // while focus is still on the button (or nowhere), so a later move is never overridden.
        if (
          server.state === 'done' &&
          clientIssues.length === 0 &&
          newServerIssues(server.issues, clientIssues).length > 0
        ) {
          const active = document.activeElement;
          if (!active || active === document.body || active.hasAttribute('data-check-workflow')) {
            // The panel is not in the DOM until this answer renders, so ask for it to open after
            // that commit (a timer would race React's render).
            setRevealIssues((n) => n + 1);
          }
        }
      });
  }, [lint, spec, templateId, teamId, baseVersion, validateAsync, openIssuesPanel]);
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

  return {
    canvasRef,
    checkResult,
    edges,
    fit,
    framed,
    handleConnect,
    handleDeleteNode,
    handleDragOver,
    handleDrop,
    handleEdgesChange,
    handleOverlayKeyDown,
    handlePaletteAdd,
    handleRename,
    inspectorRef,
    issues,
    issuesRef,
    issuesSummaryRef,
    knownGroups,
    nodesWithSelection,
    onNodesChange,
    outlineRef,
    outlineVisible: showOutline,
    paletteOpen,
    paletteRef,
    runCheck,
    selectedNode,
    selectedStepMeta,
    serverExtra,
    serverIssues,
    setOutlineVisible: setShowOutline,
    setPaletteOpen,
    shownErrors,
    shownWarnings,
    wrapperRef,
  };
}
