'use client';

import type { TeamSummary } from '@auto-swe/shared/types/api';
import { createContext, useContext } from 'react';

export interface TeamSpace {
  team: TeamSummary;
  /** Whether the Settings tab is offered to the caller. */
  canSeeSettings: boolean;
}

const TeamSpaceContext = createContext<TeamSpace | null>(null);

export const TeamSpaceProvider = TeamSpaceContext.Provider;

/** The team a team-space tab belongs to, resolved by the layout from the route's slug. */
export function useTeamSpace(): TeamSpace {
  const value = useContext(TeamSpaceContext);
  if (!value) {
    throw new Error('useTeamSpace must be used inside a team space');
  }
  return value;
}
