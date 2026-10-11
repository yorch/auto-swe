'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ProductTour } from '@/components/tour/ProductTour';
import { BUTTON_STYLE, buttonClassName } from '@/components/ui/Button';
import { focusMainContent, useDismissed, writeDismissed } from '@/lib/dismissed';
import { buildTourSteps } from '@/lib/tourSteps';
import { useAuthStore } from '@/stores/authStore';

/** The "tour seen" flag, kept with the other per-viewer flags in `lib/dismissed.ts`. */
export const TOUR_SEEN_KEY = 'product-tour';

/** The first link or button of the sidebar drawer, when it is outside any inert region. */
function focusOpenDrawer(): void {
  const drawer = document.querySelector<HTMLElement>('[data-tour="sidebar"]');
  if (!drawer || drawer.closest('[inert]')) {
    return;
  }
  drawer
    .querySelector<HTMLElement>('a[href], button:not([disabled])')
    ?.focus({ preventScroll: true });
}

/**
 * A quiet button on Home that starts the product tour. Only a click starts it. Ending the tour
 * any way (Done, Skip tour, Escape) records it as seen, so the label becomes "Take the tour
 * again", and focus returns to this button. Leaving the page mid-tour records it as seen too.
 */
export function TourLauncher() {
  const role = useAuthStore((s) => s.user?.role);
  const steps = useMemo(() => buildTourSteps(role), [role]);
  const { ready, dismissed, dismiss } = useDismissed(TOUR_SEEN_KEY);
  const [running, setRunning] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const runningRef = useRef(false);
  runningRef.current = running;

  // The anchors are sidebar links, so following one navigates away and unmounts this launcher
  // with the tour still open. That ends the tour: record it as seen (focus is not moved, the page
  // it would go to is going away; the tour's own cleanup removes its outline and listeners).
  useEffect(
    () => () => {
      if (runningRef.current) {
        writeDismissed(TOUR_SEEN_KEY, useAuthStore.getState().user?.sub);
      }
    },
    []
  );

  const onEnd = useCallback(() => {
    setRunning(false);
    dismiss();
    // The button stays mounted, so focus goes back to where the tour was started; if it is
    // gone, the main region keeps the user's place. A focus call can also be a silent no-op: with
    // the mobile menu open the whole page, launcher and main region included, is `inert`. Check
    // each call took, and last fall back to the open drawer, which sits outside the inert page.
    const button = buttonRef.current;
    if (button?.isConnected) {
      button.focus();
      if (document.activeElement === button) {
        return;
      }
    }
    focusMainContent();
    const main = document.getElementById('main-content');
    if (main && document.activeElement === main) {
      return;
    }
    focusOpenDrawer();
  }, [dismiss]);

  if (!ready) {
    return null;
  }

  return (
    <div className="flex">
      <button
        aria-expanded={running}
        aria-haspopup="dialog"
        className={buttonClassName('ghost', 'sm')}
        onClick={() => setRunning(true)}
        ref={buttonRef}
        style={BUTTON_STYLE}
        type="button"
      >
        {dismissed ? 'Take the tour again' : 'Take the tour'}
      </button>
      {running && <ProductTour onEnd={onEnd} steps={steps} />}
    </div>
  );
}
