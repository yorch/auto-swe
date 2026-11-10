'use client';

import { useEffect } from 'react';
import type { PageTourStep } from '@/lib/tourSteps';
import { useHelpStore } from '@/stores/helpStore';

/**
 * A tour of the page that renders it. It draws nothing: it hands its steps to the Help panel,
 * which offers "Tour this page", while the page is mounted. Pass a module-level constant (the
 * steps are registered when the array identity changes). A step's anchor is a `data-tour`
 * attribute the page renders itself; one that is hidden at the time falls back to a centred card.
 */
export function PageTour({ steps }: { steps: PageTourStep[] }) {
  const setPageTour = useHelpStore((s) => s.setPageTour);
  useEffect(() => {
    setPageTour(steps);
    return () => setPageTour(null);
  }, [steps, setPageTour]);
  return null;
}
