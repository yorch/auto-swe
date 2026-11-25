'use client';

import type { TeamSummary } from '@auto-swe/shared/types/api';
import { usePlatformAdmin } from '@/hooks/useCan';
import { useEffectivePermissions } from '@/hooks/useEffectivePermissions';
import { useMeSummary } from '@/hooks/useMeSummary';
import { useTeams } from '@/hooks/useTeams';

/**
 * Splits the teams a caller can see into the ones they are on (`member`, with a role of their
 * own) and the ones they reach through organization or platform authority (`administered`), each
 * sorted by name. Where the authority comes from is the server's answer; `myRole` is only whether
 * the caller has a membership row.
 */
export function splitTeamsByStanding(teams: readonly TeamSummary[]): {
  member: TeamSummary[];
  administered: TeamSummary[];
} {
  const sorted = [...teams].sort((a, b) => a.name.localeCompare(b.name));
  return {
    administered: sorted.filter((t) => t.myRole == null),
    member: sorted.filter((t) => t.myRole != null),
  };
}

export interface TeamNavEntry {
  team: TeamSummary;
  /** Items waiting on the caller on this team's work; 0 until the desk has answered. */
  needsYou: number;
}

/**
 * The teams the caller belongs to, for navigation: sorted by name, each with the "needs you"
 * count the desk reports. Only teams with a role of the caller's own are listed in `entries` — a
 * platform ADMIN sees every team elsewhere, but their switcher holds the teams they are in.
 * `administered` holds the other teams the visible list carries for someone who is not a platform
 * ADMIN (an organization admin's teams they are not on), by name and without counts: a non-member
 * has nothing waiting there. Empty for a platform ADMIN, who reaches teams as before.
 */
export function useTeamNav(): {
  entries: TeamNavEntry[];
  administered: TeamSummary[];
  isLoading: boolean;
} {
  const teams = useTeams({ memberOnly: true });
  const summary = useMeSummary();
  const permissions = useEffectivePermissions();
  const isPlatformAdmin = usePlatformAdmin();
  const visible = useTeams({ enabled: !!permissions.data && !isPlatformAdmin });
  const needs = new Map((summary.data?.teams ?? []).map((t) => [t.teamId, t.needsYou]));
  const entries = (teams.data ?? [])
    .filter((team) => team.myRole != null)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((team) => ({ needsYou: needs.get(team.id) ?? 0, team }));
  const memberIds = new Set(entries.map((e) => e.team.id));
  const administered =
    permissions.data && !isPlatformAdmin
      ? (visible.data ?? [])
          .filter((team) => team.myRole == null && !memberIds.has(team.id))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];
  return { administered, entries, isLoading: teams.isLoading };
}
