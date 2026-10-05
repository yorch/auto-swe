/**
 * Focus an element that may not accept focus yet. Returns a function that cancels it.
 *
 * React Flow draws a node `visibility: hidden` until it has measured it, and the
 * browser ignores `focus()` on a hidden element without saying so. A node that has
 * just been put on the canvas (the members of a group the viewer expanded) is in
 * that state for a frame or two, so a single `focus()` leaves focus on `<body>` and
 * a keyboard user loses their place. Try each frame until the element holds focus.
 *
 * It never takes focus back: if, between frames, focus is on something that is neither
 * `<body>` nor the element that had it when this started (the card being replaced), the
 * person moved it themselves (Tab, a click) and the attempt ends.
 */
export function focusWhenReady(
  find: () => HTMLElement | null,
  options: { doc?: Document; frames?: number; schedule?: (cb: () => void) => void } = {}
): () => void {
  const schedule = options.schedule ?? ((cb: () => void) => void requestAnimationFrame(cb));
  const doc = options.doc ?? document;
  const origin = doc.activeElement;
  let left = options.frames ?? 30;
  let cancelled = false;
  const tick = () => {
    if (cancelled) {
      return;
    }
    const active = doc.activeElement;
    if (active && active !== doc.body && active !== origin) {
      return;
    }
    const el = find();
    if (el) {
      el.focus();
      if (doc.activeElement === el) {
        return;
      }
    }
    left -= 1;
    if (left > 0) {
      schedule(tick);
    }
  };
  schedule(tick);
  return () => {
    cancelled = true;
  };
}
