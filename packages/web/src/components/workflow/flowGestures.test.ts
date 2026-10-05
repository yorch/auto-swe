import { describe, expect, it } from 'vitest';
import { flowGestureProps, gesturesLocked } from './flowGestures';

describe('gesturesLocked', () => {
  it('locks only a scroll-safe graph, below the breakpoint, until it is switched on', () => {
    expect(gesturesLocked(true, true, false)).toBe(true);
    expect(gesturesLocked(true, true, true)).toBe(false);
    expect(gesturesLocked(true, false, false)).toBe(false);
  });

  it('never locks a graph on a page that did not ask for it', () => {
    expect(gesturesLocked(false, true, false)).toBe(false);
    expect(gesturesLocked(false, false, false)).toBe(false);
  });
});

describe('flowGestureProps', () => {
  it('turns every capturing gesture off when locked, so wheel and swipes reach the page', () => {
    expect(flowGestureProps(true)).toEqual({
      panOnDrag: false,
      preventScrolling: false,
      zoomOnPinch: false,
      zoomOnScroll: false,
    });
  });

  it('is React Flow behaviour when not locked', () => {
    expect(Object.values(flowGestureProps(false)).every(Boolean)).toBe(true);
  });
});
