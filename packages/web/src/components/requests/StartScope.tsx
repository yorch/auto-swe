'use client';

import { createContext, useContext } from 'react';
import type { ScopeTeam } from '@/lib/repoGroups';

/** What the Start work forms need to know about the team the work is being started for. */
export interface StartScopeValue {
  /** The team named by `?team=`; null when the work is not scoped to one. */
  team: ScopeTeam | null;
  /**
   * Teams whose repositories an epic may span: those the caller leads. `'all'` for a platform
   * ADMIN; null until known, which allows none.
   */
  epicTeamIds: ReadonlySet<string> | 'all' | null;
}

const StartScopeContext = createContext<StartScopeValue | null>(null);

export const StartScopeProvider = StartScopeContext.Provider;

/** The Start work scope; outside Start work there is none: no grouping focus, no epic limit. */
export function useStartScope(): StartScopeValue | null {
  return useContext(StartScopeContext);
}

/** Whether an epic may include a repository owned by `teamId`. */
export function epicAllowsTeam(scope: StartScopeValue | null, teamId: string): boolean {
  if (!scope) {
    return true;
  }
  return scope.epicTeamIds === 'all' || (scope.epicTeamIds?.has(teamId) ?? false);
}
