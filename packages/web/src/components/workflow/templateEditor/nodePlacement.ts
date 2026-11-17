import { NODE_HEIGHT, NODE_WIDTH } from '@/lib/workflowLayout';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Gap kept between a node added from the palette and its neighbours, in flow units. */
const GAP = 48;

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Where a node added from the palette (click, tap or keyboard) goes, in flow coordinates.
 * Beside the selected node when there is one (the flow reads left to right), else at the centre
 * of what the canvas shows, else after the rightmost node (the canvas is hidden behind the
 * palette drawer, so it has no size). A spot another node already holds is moved down past it.
 */
export function palettePlacement(input: {
  nodes: Box[];
  selected?: Box;
  /** The flow-space centre of the visible canvas; absent while the canvas has no size. */
  viewCenter?: { x: number; y: number };
}): { x: number; y: number } {
  const { nodes, selected, viewCenter } = input;
  let spot: { x: number; y: number };
  if (selected) {
    spot = { x: selected.x + selected.width + GAP, y: selected.y };
  } else if (viewCenter) {
    spot = { x: viewCenter.x - NODE_WIDTH / 2, y: viewCenter.y - NODE_HEIGHT / 2 };
  } else {
    const right = nodes.reduce<Box | null>(
      (r, n) => (!r || n.x + n.width > r.x + r.width ? n : r),
      null
    );
    spot = right ? { x: right.x + right.width + GAP, y: right.y } : { x: 0, y: 0 };
  }
  for (let i = 0; i < nodes.length + 1; i++) {
    const box = { height: NODE_HEIGHT, width: NODE_WIDTH, x: spot.x, y: spot.y };
    const hit = nodes.find((n) => overlaps(box, n));
    if (!hit) {
      break;
    }
    spot = { x: spot.x, y: hit.y + hit.height + GAP / 2 };
  }
  return spot;
}
