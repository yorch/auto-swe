import { describe, expect, it } from 'vitest';
import { NODE_HEIGHT, NODE_WIDTH } from '@/lib/workflowLayout';
import { type Box, palettePlacement } from './nodePlacement';

const box = (x: number, y: number): Box => ({ height: NODE_HEIGHT, width: NODE_WIDTH, x, y });

describe('palettePlacement', () => {
  it('puts a node beside the selected one', () => {
    const selected = box(100, 50);
    const spot = palettePlacement({ nodes: [selected], selected });
    expect(spot.x).toBeGreaterThanOrEqual(selected.x + NODE_WIDTH);
    expect(spot.y).toBe(50);
  });

  it('centres on the visible canvas when nothing is selected', () => {
    const spot = palettePlacement({ nodes: [], viewCenter: { x: 500, y: 300 } });
    expect(spot).toEqual({ x: 500 - NODE_WIDTH / 2, y: 300 - NODE_HEIGHT / 2 });
  });

  it('goes after the rightmost node when the canvas has no size', () => {
    const spot = palettePlacement({ nodes: [box(0, 0), box(400, 20)] });
    expect(spot.x).toBeGreaterThanOrEqual(400 + NODE_WIDTH);
    expect(spot.y).toBe(20);
  });

  it('starts at the origin on an empty hidden canvas', () => {
    expect(palettePlacement({ nodes: [] })).toEqual({ x: 0, y: 0 });
  });

  it('moves down past a node already in the spot', () => {
    const selected = box(0, 0);
    const taken = box(selected.x + NODE_WIDTH + 48, 0);
    const spot = palettePlacement({ nodes: [selected, taken], selected });
    expect(spot.x).toBe(taken.x);
    expect(spot.y).toBeGreaterThanOrEqual(NODE_HEIGHT);
  });
});
