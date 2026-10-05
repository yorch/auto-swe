'use client';

import type { PullRequestState } from '@auto-swe/shared/lib/pullRequest';
import type { PullRequestListItem, TicketGroup } from '@auto-swe/shared/types/api';
import { useListQuery } from '@/hooks/useListQuery';
import { api } from '@/lib/api';
import { useTeamStore } from '@/stores/teamStore';

export type WorkScope = 'MINE' | 'TEAM';

/** The query string for the set values; the shell's selected team narrows it, as for requests. */
function queryString(
  filters: Record<string, string | number | boolean | undefined>,
  teamId: string | null
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, ...(teamId ? { teamId } : {}) })) {
    if (value !== undefined && value !== '') {
      params.set(key, String(value));
    }
  }
  return params.toString();
}

export function usePullRequests(filters: {
  scope: WorkScope;
  state: PullRequestState | 'all';
  draft: 'any' | 'draft' | 'ready';
  repoId?: string;
  ticket?: string;
  limit: number;
  offset: number;
}) {
  const teamId = useTeamStore((state) => state.selectedTeamId);
  const qs = queryString(filters, teamId);
  return useListQuery<PullRequestListItem>({
    queryFn: () => api.get(`/api/v1/pull-requests?${qs}`),
    queryKey: ['pull-requests', qs],
    refetchInterval: 10_000,
  });
}

export function useTickets(filters: {
  scope: WorkScope;
  includeAutomated: boolean;
  search?: string;
  limit: number;
  offset: number;
}) {
  const teamId = useTeamStore((state) => state.selectedTeamId);
  const qs = queryString(filters, teamId);
  return useListQuery<TicketGroup>({
    queryFn: () => api.get(`/api/v1/tickets?${qs}`),
    queryKey: ['tickets', qs],
    refetchInterval: 10_000,
  });
}
