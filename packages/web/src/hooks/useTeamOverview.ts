'use client';

import type { TeamOverview } from '@auto-swe/shared/types/api';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** One team's overview. Fields the caller's team role may not see are absent, never nulled. */
export function useTeamOverview(teamId: string | undefined) {
  return useQuery({
    enabled: !!teamId,
    queryFn: () =>
      api.get<{ data: TeamOverview }>(`/api/v1/teams/${teamId}/overview`).then((r) => r.data),
    queryKey: ['team-overview', teamId],
    refetchInterval: 30_000,
  });
}
