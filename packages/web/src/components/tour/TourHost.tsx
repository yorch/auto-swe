'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { ProductTour } from '@/components/tour/ProductTour';
import { restoreTourFocus, TOUR_SEEN_KEY } from '@/components/tour/tourSupport';
import { writeDismissed } from '@/lib/dismissed';
import { buildTourSteps } from '@/lib/tourSteps';
import { useAuthStore } from '@/stores/authStore';
import { useHelpStore } from '@/stores/helpStore';

/**
 * Runs the tour the Help panel asked for. It lives in the shell, so the product tour survives the
 * sidebar link it points at being followed, and a per-page tour ends when its page unmounts.
 * Ending the product tour any way records it as seen; ending a page tour does not.
 */
export function TourHost() {
  const request = useHelpStore((s) => s.tourRequest);
  const pageTour = useHelpStore((s) => s.pageTour);
  const endTour = useHelpStore((s) => s.endTour);
  const role = useAuthStore((s) => s.user?.role);
  const productSteps = useMemo(() => buildTourSteps(role), [role]);
  const requestRef = useRef(request);
  requestRef.current = request;

  const onEnd = useCallback(() => {
    const current = requestRef.current;
    if (!current) {
      return;
    }
    endTour();
    if (current.kind === 'product') {
      writeDismissed(TOUR_SEEN_KEY, useAuthStore.getState().user?.sub);
    }
    restoreTourFocus(current.opener);
  }, [endTour]);

  // The page the tour was about is gone (navigation, or it stopped registering): end it quietly.
  const pageGone = request?.kind === 'page' && !pageTour;
  useEffect(() => {
    if (pageGone) {
      endTour();
    }
  }, [pageGone, endTour]);

  if (!request || pageGone) {
    return null;
  }
  const steps = request.kind === 'product' ? productSteps : (pageTour ?? []);
  return <ProductTour key={request.kind} onEnd={onEnd} steps={steps} />;
}
