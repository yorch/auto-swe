'use client';

import { getNodesBounds, useReactFlow, useStoreApi } from '@xyflow/react';
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

/**
 * The viewport that shows a graph at a readable size.
 *
 * `fitView` clamps its zoom to `minZoom` (so a large graph is never fitted to
 * unreadable text) but then still centres the graph, which for a graph that
 * cannot fit throws away both ends: the viewer lands in the middle of the flow
 * with its start and its end cut off. Here, on an axis where the graph does not
 * fit at the floor, the graph is anchored to the leading edge instead (left, top)
 * so the entry node is on screen and the rest is a pan away. An axis where it
 * does fit stays centred, so a graph that fits looks exactly as `fitView` drew it.
 */
export function readableViewport(
  bounds: Rect,
  size: { width: number; height: number },
  options: FitOptions = FIT_VIEW_OPTIONS
): { x: number; y: number; zoom: number } {
  const span = 1 + options.padding * 2;
  const wanted = Math.min(
    bounds.width > 0 ? size.width / (bounds.width * span) : Number.POSITIVE_INFINITY,
    bounds.height > 0 ? size.height / (bounds.height * span) : Number.POSITIVE_INFINITY
  );
  const zoom = Math.min(
    options.maxZoom,
    Math.max(options.minZoom, Number.isFinite(wanted) ? wanted : options.maxZoom)
  );
  const place = (origin: number, extent: number, room: number): number => {
    const used = extent * zoom;
    return used <= room - ANCHOR_MARGIN * 2
      ? (room - used) / 2 - origin * zoom
      : ANCHOR_MARGIN - origin * zoom;
  };
  return {
    x: place(bounds.x, bounds.width, size.width),
    y: place(bounds.y, bounds.height, size.height),
    zoom,
  };
}

/** Fit the current nodes with `readableViewport`. Call inside a `<ReactFlowProvider>`. */
export function useFitFlow(): () => void {
  const flow = useReactFlow();
  const store = useStoreApi();
  return useCallback(() => {
    const { width, height } = store.getState();
    const nodes = flow.getNodes();
    if (nodes.length === 0 || !width || !height) {
      return;
    }
    void flow.setViewport(readableViewport(getNodesBounds(nodes), { height, width }));
  }, [flow, store]);
}
