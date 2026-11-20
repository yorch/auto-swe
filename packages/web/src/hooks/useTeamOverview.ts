'use client';

import type { TeamOverview } from '@auto-swe/shared/types/api';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * The overview as the gateway sends it. `needsAdmin` is present, and true, only for a viewer who
 * can manage the team's members, when the team has no admin.
 */
export type TeamOverviewData = TeamOverview & {
  needsAdmin?: boolean;
  /** Open join requests; present only for a caller who holds `team.members.manage`. */
  pendingJoinRequests?: number;
};

/** One team's overview. Fields the caller's team role may not see are absent, never nulled. */
export function useTeamOverview(teamId: string | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: !!teamId && (options.enabled ?? true),
    queryFn: () =>
      api.get<{ data: TeamOverviewData }>(`/api/v1/teams/${teamId}/overview`).then((r) => r.data),
    queryKey: ['team-overview', teamId],
    refetchInterval: 30_000,
  });
}
