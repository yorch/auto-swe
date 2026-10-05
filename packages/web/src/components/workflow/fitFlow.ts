'use client';

import { getViewportForBounds, useReactFlow, useStoreApi } from '@xyflow/react';
import { useCallback } from 'react';
import { FIT_VIEW_OPTIONS } from './specToFlow';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FitOptions {
  maxZoom: number;
  minZoom: number;
  padding: number;
}

/** Margin kept around a graph that is anchored to an edge of the canvas, in px. */
const ANCHOR_MARGIN = 24;

/** React Flow's own conversion of a numeric `padding` to pixels per side. */
const paddingPx = (viewport: number, padding: number): number =>
  Math.floor((viewport - viewport / (1 + padding)) * 0.5);

/**
 * The viewport that shows a graph at a readable size.
 *
 * `fitView` clamps its zoom to `minZoom` (so a large graph is never fitted to
 * unreadable text) but then still centres the graph, which for a graph that
 * cannot fit throws away both ends: the viewer lands in the middle of the flow.
 * The base viewport here is React Flow's own (`getViewportForBounds`), so a graph
 * that fits is drawn exactly as `fitView` draws it. Only an axis that overflows at
 * the zoom floor is changed, and it is anchored on the `entry` node (the bounding
 * box edge when there is none) so the start of the flow is what is on screen and the
 * rest is a pan away.
 */
export function readableViewport(
  bounds: Rect,
  size: { width: number; height: number },
  options: FitOptions = FIT_VIEW_OPTIONS,
  entry?: Rect
): { x: number; y: number; zoom: number } {
  const base = getViewportForBounds(
    bounds,
    size.width,
    size.height,
    options.minZoom,
    options.maxZoom,
    options.padding
  );
  if (!(bounds.width > 0 && bounds.height > 0)) {
    return base;
  }
  const { zoom } = base;
  const overflowsX =
    bounds.width * zoom > size.width - 2 * paddingPx(size.width, options.padding) + 0.5;
  const overflowsY =
    bounds.height * zoom > size.height - 2 * paddingPx(size.height, options.padding) + 0.5;
  const target = entry ?? bounds;
  // Leading edge of the entry at the margin, but never past the bounds' own edge.
  const x = overflowsX ? ANCHOR_MARGIN - target.x * zoom : base.x;
  const y = overflowsY
    ? Math.min(
        ANCHOR_MARGIN - bounds.y * zoom,
        // The entry's centre on the canvas's, so one in the middle of a tall graph is seen.
        size.height / 2 - (target.y + target.height / 2) * zoom
      )
    : base.y;
  return { x, y, zoom };
}

/**
 * Fit the current nodes with `readableViewport`, anchored on `entryId` when that node is
 * drawn. Call inside a `<ReactFlowProvider>`.
 */
export function useFitFlow(entryId?: string): () => void {
  const flow = useReactFlow();
  const store = useStoreApi();
  return useCallback(() => {
    const { width, height } = store.getState();
    const nodes = flow.getNodes();
    if (nodes.length === 0 || !width || !height) {
      return;
    }
    const entryNode = entryId ? flow.getNode(entryId) : undefined;
    const entry = entryNode ? flow.getNodesBounds([entryNode]) : undefined;
    void flow.setViewport(
      readableViewport(flow.getNodesBounds(nodes), { height, width }, undefined, entry)
    );
  }, [flow, store, entryId]);
}

/**
 * Whether the viewport should be refitted. Only when the thing being looked at changed
 * (another spec, a view switch, a fold the viewer toggled) and the store holds the nodes
 * for it, measured. A poll that recolours a node rebuilds its node object, which makes
 * React Flow re-measure and flip `nodesInitialized`; that must never throw away the
 * viewer's pan and zoom.
 */
export function shouldFit(state: {
  initialized: boolean;
  /** The ids the store holds are the ids the current spec draws. */
  drawnMatches: boolean;
  fittedKey: string | null;
  key: string;
}): boolean {
  return state.initialized && state.drawnMatches && state.fittedKey !== state.key;
}
