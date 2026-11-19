'use client';

import { useMemo } from 'react';
import { useCan, usePlatformAdmin } from '@/hooks/useCan';
import { buildTourSteps, type TourStep } from '@/lib/tourSteps';

/** The product tour's steps for the signed-in person, from what the server says they may do. */
export function useTourSteps(): TourStep[] {
  const platformAdmin = usePlatformAdmin();
  const teamLead = useCan('team.launch.multi-repo');
  return useMemo(() => buildTourSteps({ platformAdmin, teamLead }), [platformAdmin, teamLead]);
}
