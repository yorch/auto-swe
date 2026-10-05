import { describe, expect, it } from 'vitest';
import { readableViewport } from './fitFlow';

const OPTIONS = { maxZoom: 1.2, minZoom: 0.55, padding: 0.18 };

describe('readableViewport', () => {
  it('centres a graph that fits, as fitView would', () => {
    const vp = readableViewport(
      { height: 100, width: 200, x: 0, y: 0 },
      { height: 400, width: 800 },
      OPTIONS
    );
    // 800 / (200 * 1.36) = 2.94, capped at maxZoom.
    expect(vp.zoom).toBeCloseTo(1.2);
    expect(vp.x).toBeCloseTo((800 - 200 * 1.2) / 2);
    expect(vp.y).toBeCloseTo((400 - 100 * 1.2) / 2);
  });

  it('keeps the whole graph on screen when it fits above the readable floor', () => {
    const vp = readableViewport(
      { height: 300, width: 1000, x: 50, y: 20 },
      { height: 500, width: 877 },
      OPTIONS
    );
    expect(vp.zoom).toBeGreaterThanOrEqual(OPTIONS.minZoom);
    expect(vp.x + 50 * vp.zoom).toBeGreaterThanOrEqual(0);
    expect(vp.x + (50 + 1000) * vp.zoom).toBeLessThanOrEqual(877);
  });

  it('starts at the beginning of a graph too wide for the readable floor, not its middle', () => {
    // 3000 wide at 0.55 is 1650px on an 877px canvas: it cannot all fit, so the
    // entry (leftmost) node must be what is on screen.
    const bounds = { height: 400, width: 3000, x: 120, y: 40 };
    const vp = readableViewport(bounds, { height: 497, width: 877 }, OPTIONS);
    expect(vp.zoom).toBeCloseTo(OPTIONS.minZoom);
    const left = vp.x + bounds.x * vp.zoom;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThan(60);
  });

  it('starts at the top of a graph too tall for the readable floor', () => {
    const bounds = { height: 2400, width: 400, x: 0, y: 10 };
    const vp = readableViewport(bounds, { height: 497, width: 877 }, OPTIONS);
    expect(vp.zoom).toBeCloseTo(OPTIONS.minZoom);
    const top = vp.y + bounds.y * vp.zoom;
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(60);
    // The short axis stays centred.
    expect(vp.x).toBeCloseTo((877 - 400 * vp.zoom) / 2 - 0);
  });

  it('is finite for an empty or unmeasured graph', () => {
    const vp = readableViewport(
      { height: 0, width: 0, x: 0, y: 0 },
      { height: 400, width: 800 },
      OPTIONS
    );
    expect(Number.isFinite(vp.x)).toBe(true);
    expect(Number.isFinite(vp.y)).toBe(true);
    expect(Number.isFinite(vp.zoom)).toBe(true);
  });
});
