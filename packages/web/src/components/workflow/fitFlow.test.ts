import { getViewportForBounds } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { readableViewport, shouldFit } from './fitFlow';

const OPTIONS = { maxZoom: 1.2, minZoom: 0.55, padding: 0.18 };
const fitView = (
  b: { x: number; y: number; width: number; height: number },
  s: { width: number; height: number }
) => getViewportForBounds(b, s.width, s.height, OPTIONS.minZoom, OPTIONS.maxZoom, OPTIONS.padding);

describe('readableViewport', () => {
  it('draws a graph that fits exactly as fitView does, when capped at maxZoom', () => {
    const b = { height: 100, width: 200, x: 0, y: 0 };
    const s = { height: 400, width: 800 };
    expect(readableViewport(b, s, OPTIONS)).toEqual(fitView(b, s));
  });

  it('draws a graph that fits exactly as fitView does, when not capped', () => {
    // 1000 wide on 877: fitView zooms to ~0.745, well inside [0.55, 1.2].
    const cases = [
      [
        { height: 300, width: 1000, x: 50, y: 20 },
        { height: 500, width: 877 },
      ],
      // Between 1.18x and 1.36x the floor: fitView still fits it, at ~0.62.
      [
        { height: 300, width: 1200, x: 0, y: 0 },
        { height: 497, width: 877 },
      ],
    ] as const;
    for (const [b, s] of cases) {
      const vp = readableViewport(b, s, OPTIONS);
      expect(vp).toEqual(fitView(b, s));
      expect(vp.zoom).toBeGreaterThan(OPTIONS.minZoom);
    }
  });

  it('starts at the entry node of a graph too wide for the readable floor', () => {
    const b = { height: 400, width: 3000, x: 120, y: 40 };
    const entry = { height: 40, width: 150, x: 120, y: 200 };
    const vp = readableViewport(b, { height: 497, width: 877 }, OPTIONS, entry);
    expect(vp.zoom).toBeCloseTo(OPTIONS.minZoom);
    const left = vp.x + entry.x * vp.zoom;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThan(60);
  });

  it('keeps an entry node that sits mid-height of a tall graph on screen', () => {
    // 2400 tall at 0.55 is 1320px on a 497px canvas, and the entry is half way down.
    const b = { height: 2400, width: 400, x: 0, y: 0 };
    const entry = { height: 40, width: 150, x: 0, y: 1180 };
    const size = { height: 497, width: 877 };
    const vp = readableViewport(b, size, OPTIONS, entry);
    expect(vp.zoom).toBeCloseTo(OPTIONS.minZoom);
    const top = vp.y + entry.y * vp.zoom;
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top + entry.height * vp.zoom).toBeLessThanOrEqual(size.height);
    // The short axis stays as fitView centres it.
    expect(vp.x).toBeCloseTo((size.width - b.width * vp.zoom) / 2 - b.x * vp.zoom, 0);
  });

  it('starts at the top when the entry is near the top of a tall graph', () => {
    const b = { height: 2400, width: 400, x: 0, y: 10 };
    const entry = { height: 40, width: 150, x: 0, y: 10 };
    const vp = readableViewport(b, { height: 497, width: 877 }, OPTIONS, entry);
    const top = vp.y + b.y * vp.zoom;
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(60);
  });

  it('falls back to the bounding box edge without an entry, and is finite when empty', () => {
    const vp = readableViewport(
      { height: 400, width: 3000, x: 120, y: 40 },
      { height: 497, width: 877 },
      OPTIONS
    );
    expect(vp.x + 120 * vp.zoom).toBeLessThan(60);
    const empty = readableViewport(
      { height: 0, width: 0, x: 0, y: 0 },
      { height: 400, width: 800 },
      OPTIONS
    );
    expect([empty.x, empty.y, empty.zoom].every(Number.isFinite)).toBe(true);
  });
});

describe('shouldFit', () => {
  const base = { drawnMatches: true, fittedKey: null, initialized: true, key: 'graph|a' };

  it('fits the first time the nodes are measured', () => {
    expect(shouldFit(base)).toBe(true);
  });

  it('does not refit when a poll re-measures the same view (nodesInitialized flips back to true)', () => {
    expect(shouldFit({ ...base, fittedKey: 'graph|a' })).toBe(false);
  });

  it('refits for another spec or view', () => {
    expect(shouldFit({ ...base, fittedKey: 'graph|a', key: 'graph|b' })).toBe(true);
    expect(shouldFit({ ...base, fittedKey: 'graph|a', key: 'outline|a' })).toBe(true);
  });

  it('waits for measured nodes, and for the store to hold the nodes this view draws', () => {
    expect(shouldFit({ ...base, initialized: false })).toBe(false);
    expect(shouldFit({ ...base, drawnMatches: false })).toBe(false);
  });
});
