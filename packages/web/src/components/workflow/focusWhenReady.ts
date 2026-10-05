/**
 * Focus an element that may not accept focus yet.
 *
 * React Flow draws a node `visibility: hidden` until it has measured it, and the
 * browser ignores `focus()` on a hidden element without saying so. A node that has
 * just been put on the canvas (the members of a group the viewer expanded) is in
 * that state for a frame or two, so a single `focus()` leaves focus on `<body>` and
 * a keyboard user loses their place. Try each frame until the element holds focus.
 */
export function focusWhenReady(
  find: () => HTMLElement | null,
  options: { frames?: number; schedule?: (cb: () => void) => void } = {}
): void {
  const schedule = options.schedule ?? ((cb: () => void) => void requestAnimationFrame(cb));
  let left = options.frames ?? 30;
  const tick = () => {
    const el = find();
    if (el) {
      el.focus();
      if (el.ownerDocument.activeElement === el) {
        return;
      }
    }
    left -= 1;
    if (left > 0) {
      schedule(tick);
    }
  };
  schedule(tick);
}
