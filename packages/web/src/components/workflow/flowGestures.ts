/**
 * Which pointer gestures the graph captures.
 *
 * In a page that scrolls (the run viewer below lg) a graph that takes the wheel, a one-finger
 * drag and a pinch traps the page: the pane is half the screen and a swipe over it pans instead
 * of scrolling. So there the gestures start off and the viewer turns them on with the "Pan and
 * zoom" switch. Keyboard control, the zoom buttons and tapping a node never depended on them.
 * Anywhere else (`scrollSafe` false) React Flow's defaults are left alone.
 */
export interface FlowGestureProps {
  panOnDrag: boolean;
  preventScrolling: boolean;
  zoomOnPinch: boolean;
  zoomOnScroll: boolean;
}

export function flowGestureProps(locked: boolean): FlowGestureProps {
  return {
    panOnDrag: !locked,
    preventScrolling: !locked,
    zoomOnPinch: !locked,
    zoomOnScroll: !locked,
  };
}

/** True when the gestures are off: the graph sits in a scrolling page, narrow, and not switched on. */
export function gesturesLocked(
  scrollSafe: boolean,
  narrow: boolean,
  interactive: boolean
): boolean {
  return scrollSafe && narrow && !interactive;
}
