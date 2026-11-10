'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ProductTour } from '@/components/tour/ProductTour';
import { restoreTourFocus, TOUR_SEEN_KEY } from '@/components/tour/tourSupport';
import { BUTTON_STYLE, buttonClassName } from '@/components/ui/Button';
import {
  DISMISSED_CHANGE_EVENT,
  readDismissed,
  useDismissed,
  writeDismissed,
} from '@/lib/dismissed';
import { buildTourSteps } from '@/lib/tourSteps';
import { useAuthStore } from '@/stores/authStore';

export { TOUR_SEEN_KEY };

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

  // The tour can also be run from the Help panel, which records it as seen without this button.
  const userId = useAuthStore((s) => s.user?.sub);
  useEffect(() => {
    const sync = () => {
      if (readDismissed(TOUR_SEEN_KEY, userId)) {
        dismiss();
      }
    };
    window.addEventListener(DISMISSED_CHANGE_EVENT, sync);
    return () => window.removeEventListener(DISMISSED_CHANGE_EVENT, sync);
  }, [userId, dismiss]);

  const onEnd = useCallback(() => {
    setRunning(false);
    dismiss();
    // The button stays mounted, so focus goes back to where the tour was started.
    restoreTourFocus(buttonRef.current);
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
