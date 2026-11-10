'use client';

import type { TeamSummary } from '@auto-swe/shared/types/api';
import { useMeSummary } from '@/hooks/useMeSummary';
import { useTeams } from '@/hooks/useTeams';

export interface TeamNavEntry {
  team: TeamSummary;
  /** Items waiting on the caller on this team's work; 0 until the desk has answered. */
  needsYou: number;
}

/**
 * The teams the caller belongs to, for navigation: sorted by name, each with the "needs you"
 * count the desk reports. Only teams with a role of the caller's own are listed — a platform
 * ADMIN sees every team elsewhere, but their switcher holds the teams they are in.
 */
export function useTeamNav(): { entries: TeamNavEntry[]; isLoading: boolean } {
  const teams = useTeams({ memberOnly: true });
  const summary = useMeSummary();
  const needs = new Map((summary.data?.teams ?? []).map((t) => [t.teamId, t.needsYou]));
  const entries = (teams.data ?? [])
    .filter((team) => team.myRole != null)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((team) => ({ needsYou: needs.get(team.id) ?? 0, team }));
  return { entries, isLoading: teams.isLoading };
}
