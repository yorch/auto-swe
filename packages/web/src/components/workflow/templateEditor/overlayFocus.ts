/** The element that had focus when an overlay opened, so closing can give focus back. */
export function rememberTrigger(): HTMLElement | null {
  const el = document.activeElement;
  return el instanceof HTMLElement && el !== document.body ? el : null;
}

/** Returns focus to the remembered trigger once its overlay closed, if it is still on the page. */
export function restoreTrigger(ref: { current: HTMLElement | null }) {
  const el = ref.current;
  ref.current = null;
  if (el?.isConnected) {
    el.focus();
  }
}

/** Moves focus to the first control inside an overlay, or the overlay itself. */
export function focusFirst(container: HTMLElement | null) {
  const target = container?.querySelector<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  (target ?? container)?.focus();
}

/** Below lg the side panels are overlays on the canvas. */
export function overlayMode() {
  return !window.matchMedia('(min-width: 1024px)').matches;
}
