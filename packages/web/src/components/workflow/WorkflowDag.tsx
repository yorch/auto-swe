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
 *   - two display-only folds: bookkeeping nodes out of the view, and each
 *     `group` into one card (neither ever changes the spec)
 *   - optionally, an outline (list) view of the same spec
 *
 * For interactive editing, prefer the higher-level <TemplateEditor> wrapper
 * which adds drag-to-create, drag-to-connect, and an inspector rail.
 */

import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import {
  ReactFlow,
  ReactFlowProvider,
  type Node as RFNode,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { adjacentNodeId, type NavDirection } from './dagKeyboardNav';
import { DagNode, type DagNodeData } from './dagNode';
import { useFitFlow } from './fitFlow';
import { FlowChrome } from './flowChrome';
import { focusWhenReady } from './focusWhenReady';
import { foldBookkeeping } from './foldBookkeeping';
import { foldGroups } from './foldGroups';
import { FIT_VIEW_OPTIONS, specToFlow } from './specToFlow';
import { WorkflowOutline } from './WorkflowOutline';

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
  /**
   * Start with bookkeeping nodes (`set`, `updateDomainState`) folded out of the
   * view. Defaults to on for graphs past {@link AUTO_FOLD_NODE_COUNT} nodes. The
   * viewer can flip it either way; the spec itself is never changed.
   */
  foldBookkeeping?: boolean;
  /** Offer a Graph / Outline switch. The outline lists the same spec as rows. */
  outline?: boolean;
}

/** Graphs larger than this open folded unless the caller says otherwise. */
export const AUTO_FOLD_NODE_COUNT = 20;

/** Statuses a viewer is actively looking for — never folded away. */
const ALWAYS_VISIBLE_STATUSES = new Set(['FAILED', 'RUNNING', 'PENDING']);

const NODE_TYPES = { dag: DagNode };

const VIEW_OPTIONS = [
  { label: 'Graph', value: 'graph' },
  { label: 'Outline', value: 'outline' },
] as const;

const TOOLBAR_BUTTON =
  'rounded-sm border border-ink-600 bg-ink-800/90 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-paper-400 hover:text-paper-100';

function InnerDag({
  spec: fullSpec,
  statuses,
  diffMarkers,
  selectedNodeId,
  onSelect,
  height,
  foldBookkeeping: foldDefault,
  outline,
}: Props) {
  const [view, setView] = useState<'graph' | 'outline'>('graph');
  const [folded, setFolded] = useState(
    () => foldDefault ?? Object.keys(fullSpec.nodes).length > AUTO_FOLD_NODE_COUNT
  );
  // Groups the viewer has collapsed into cards. Nothing starts collapsed, and a different
  // spec (another version) starts over: its labels mean other groups.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const specContentKey = JSON.stringify(fullSpec);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the spec's content is the trigger
  useEffect(() => {
    setCollapsed(new Set());
  }, [specContentKey]);
  // What the viewer is looking at is never folded away: a node that failed, is
  // running or waiting, was changed in a diff, or is selected stays on the canvas.
  const keepKey = JSON.stringify([
    Object.entries(statuses?.byNodeId ?? {})
      .filter(([, v]) => v && ALWAYS_VISIBLE_STATUSES.has(v.status))
      .map(([id]) => id),
    Object.keys(diffMarkers ?? {}),
    selectedNodeId,
  ]);
  const keep = useMemo(
    () => new Set<string>(JSON.parse(keepKey).flat().filter(Boolean) as string[]),
    [keepKey]
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the serialized spec, and keepKey for what `keep` holds
  const fold = useMemo(() => foldBookkeeping(fullSpec, keep), [JSON.stringify(fullSpec), keepKey]);
  const bookkeepingSpec = folded ? fold.spec : fullSpec;
  // Then the group fold, over what the bookkeeping fold left. Groups are read off
  // that spec, so a card's count is the steps actually on screen.
  const collapsedKey = JSON.stringify([...collapsed].sort());
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on serialized content so a poll with no change does not rebuild
  const groupFold = useMemo(
    () => foldGroups(bookkeepingSpec, collapsed, keep),
    [JSON.stringify(bookkeepingSpec), collapsedKey, keepKey]
  );
  const spec = groupFold.spec;
  // Poll refreshes hand us new object identities for `spec` / `statuses` /
  // `diffMarkers` every 3-5s even when their content is unchanged. Keying the
  // memo on serialized content (rather than identity) means a poll with no
  // real change doesn't tear down and rebuild every React Flow node.
  const specKey = JSON.stringify([spec, groupFold.extraEdges]);
  const statusesKey = JSON.stringify(statuses?.byNodeId ?? null);
  const diffKey = JSON.stringify(diffMarkers ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on serialized content so identity-only poll changes don't rebuild the graph
  const initial = useMemo(
    () =>
      specToFlow(spec, {
        diffMarkers,
        extraEdges: groupFold.extraEdges,
        folded: groupFold.folded,
        statuses,
      }),
    [specKey, statusesKey, diffKey]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode<DagNodeData>>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);

  // Reflect external spec / overlay changes back into the flow state.
  // Using JSON serialization as the dep is cheap for the workflow sizes
  // we expect (<100 nodes) and avoids deep-equality libraries.
  useEffect(() => {
    setNodes(initial.nodes);
    setEdges(initial.edges);
  }, [initial.nodes, initial.edges, setNodes, setEdges]);

  // The `fitView` prop fits once, on the first render — before the nodes are
  // measured when they arrive with the spec. Fit again once they are measured
  // and whenever a different spec (another version) is shown, so the whole
  // graph is on screen on load instead of clipped at the canvas edge.
  const fit = useFitFlow();
  const nodesInitialized = useNodesInitialized();
  // Folding bookkeeping or a group changes which nodes are drawn without changing the
  // spec, so the set of drawn ids is a trigger too. Statuses do not change it, so a
  // live run's colours never pull the viewer back from where they have panned to.
  const drawnKey = initial.nodes.map((n) => n.id).join('\u0000');
  // biome-ignore lint/correctness/useExhaustiveDependencies: specKey and drawnKey are the triggers — a different spec, or a different set of drawn nodes, must be refitted.
  useEffect(() => {
    if (nodesInitialized && view === 'graph') {
      fit();
    }
  }, [nodesInitialized, specKey, drawnKey, fit, view]);

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
  // Where keyboard focus goes once an expanded group's members are on the canvas: the
  // card that had it is unmounted, which would otherwise drop focus to <body>.
  const pendingFocus = useRef<string | null>(null);

  /** Open one collapsed group. A card is not a node, so it is never "selected". */
  const expandGroup = useCallback(
    (cardId: string) => {
      const card = groupFold.folded[cardId];
      if (!card) {
        return;
      }
      pendingFocus.current = card.memberIds[0] ?? null;
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(card.group);
        return next;
      });
    },
    [groupFold.folded]
  );

  // Selecting is for real nodes; a group card opens instead.
  const selectOrExpand = useCallback(
    (id: string | null) => {
      if (id !== null && id in groupFold.folded) {
        expandGroup(id);
        return;
      }
      onSelect?.(id);
    },
    [groupFold.folded, expandGroup, onSelect]
  );

  // Move DOM focus onto a node's React Flow wrapper so focus follows keyboard
  // selection (React Flow tags each wrapper with `data-id`).
  const nodeEl = useCallback(
    (id: string) =>
      containerRef.current?.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${CSS.escape(id)}"]`
      ) ?? null,
    []
  );
  const focusNodeEl = useCallback((id: string) => nodeEl(id)?.focus(), [nodeEl]);

  useEffect(() => {
    const id = pendingFocus.current;
    if (id && nodes.some((n) => n.id === id)) {
      pendingFocus.current = null;
      // Not a single focus(): the nodes just put on the canvas are hidden until measured.
      focusWhenReady(() => nodeEl(id));
    }
  }, [nodes, nodeEl]);

  // Keyboard graph traversal: arrows walk the edges, Home jumps to the entry
  // node, Enter/Space opens the anchored node in the inspector (or expands a
  // collapsed group). The anchor is the currently focused node (falling back to
  // the selected one), so a keyboard/screen-reader user can traverse the DAG
  // without a pointer.
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
          // A card takes focus but is not selected: there is nothing to inspect.
          if (!(target in groupFold.folded)) {
            onSelect?.(target);
          }
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
        case ' ':
          if (anchor) {
            e.preventDefault();
            selectOrExpand(anchor);
          }
          break;
      }
    },
    [nodes, edges, selectedNodeId, onSelect, focusNodeEl, groupFold.folded, selectOrExpand]
  );

  const collapsibleCount = groupFold.collapsible.length;
  const collapseAll = () => setCollapsed(new Set(groupFold.collapsible));
  // How many cards are actually on the canvas: a collapsed group holding something the
  // viewer is looking for stays open, so this can be fewer than `collapsed.size`.
  const foldedCount = Object.keys(groupFold.folded).length;
  const showToolbar =
    outline || fold.hidden.length > 0 || collapsibleCount > 0 || collapsed.size > 0;

  return (
    <div
      className="relative flex flex-col rounded-sm border border-ink-600 bg-ink-900"
      style={{ height: height ?? 480 }}
    >
      {showToolbar && (
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-600/60 bg-ink-900 px-2 py-1.5">
          {outline && (
            <SegmentedControl
              ariaLabel="Workflow view"
              onChange={setView}
              options={[...VIEW_OPTIONS]}
              value={view}
            />
          )}
          {view === 'graph' && fold.hidden.length > 0 && (
            <button
              aria-pressed={folded}
              className={TOOLBAR_BUTTON}
              onClick={() => setFolded((v) => !v)}
              title="Status stamps and counters (set / updateDomainState nodes) change run state but do no work. Folding them out shortens the graph; nothing is edited."
              type="button"
            >
              {folded ? `Show ${fold.hidden.length} bookkeeping nodes` : 'Hide bookkeeping nodes'}
            </button>
          )}
          {view === 'graph' && (collapsibleCount > 0 || collapsed.size > 0) && (
            <button
              aria-pressed={collapsed.size > 0}
              className={TOOLBAR_BUTTON}
              onClick={() => (collapsed.size > 0 ? setCollapsed(new Set()) : collapseAll())}
              title="Fold each group of steps into one card. A group holding a failed, running or pending step, a diff mark, or the selected step stays open. Nothing is edited."
              type="button"
            >
              {collapsed.size > 0
                ? foldedCount > 0
                  ? `Expand ${foldedCount} group${foldedCount === 1 ? '' : 's'}`
                  : 'Expand groups'
                : `Collapse ${collapsibleCount} group${collapsibleCount === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      )}
      {view === 'outline' ? (
        <WorkflowOutline
          className="min-h-0 flex-1"
          diffMarkers={diffMarkers}
          height="100%"
          onSelect={onSelect}
          selectedNodeId={selectedNodeId}
          spec={fullSpec}
          statuses={statuses}
        />
      ) : (
        <div
          aria-label="Workflow graph. Left and right arrows follow the flow, up and down arrows switch between branches, Enter opens a step or expands a collapsed group, Home jumps to the start."
          // `role="application"` is intentional here — arrow-key navigation needs
          // raw key events rather than the browser's default roving-tabindex
          // behavior a `role="group"`/list would impose. Individual nodes carry
          // their own descriptive `aria-label` (see specToFlow's `ariaLabel`).
          aria-roledescription="workflow graph"
          className="relative min-h-0 flex-1"
          onKeyDown={onKeyDown}
          ref={containerRef}
          role="application"
        >
          <ReactFlow
            edges={edges}
            fitView
            fitViewOptions={FIT_VIEW_OPTIONS}
            maxZoom={2.5}
            minZoom={0.15}
            nodes={nodesWithSelection}
            nodesConnectable={false}
            nodesDraggable={false}
            nodeTypes={NODE_TYPES}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_, n) =>
              n.id in groupFold.folded
                ? expandGroup(n.id)
                : onSelect?.(n.id === selectedNodeId ? null : n.id)
            }
            onNodesChange={onNodesChange}
            onPaneClick={() => onSelect?.(null)}
            proOptions={{ hideAttribution: true }}
            zoomOnDoubleClick={false}
          >
            <FlowChrome onFit={fit} />
          </ReactFlow>
        </div>
      )}
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
