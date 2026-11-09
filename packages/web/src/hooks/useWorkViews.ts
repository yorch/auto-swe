'use client';

import type { PullRequestState } from '@auto-swe/shared/lib/pullRequest';
import type {
  PrEngagementResponse,
  PullRequestListItem,
  TicketGroup,
} from '@auto-swe/shared/types/api';
import { useQuery } from '@tanstack/react-query';
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

export function usePullRequests(
  filters: {
    scope: WorkScope;
    state: PullRequestState | 'all';
    draft: 'any' | 'draft' | 'ready';
    repoId?: string;
    ticket?: string;
    limit: number;
    offset: number;
  },
  options: { ignoreTeam?: boolean } = {}
) {
  const selectedTeamId = useTeamStore((state) => state.selectedTeamId);
  const qs = queryString(filters, options.ignoreTeam ? null : selectedTeamId);
  return useListQuery<PullRequestListItem>({
    queryFn: () => api.get(`/api/v1/pull-requests?${qs}`),
    queryKey: ['pull-requests', qs],
    refetchInterval: 10_000,
  });
}

/** The longest window the route reads, in days. */
export const MAX_ENGAGEMENT_DAYS = 365;

/**
 * Whether reviewers act on the brief, over the last `days` days (`/admin/analytics`). The window is
 * clamped to what the route accepts, so a long custom range asks for the longest it can answer.
 */
export function usePrEngagement(days: number, repoId?: string) {
  const window = Math.min(Math.max(Math.trunc(days), 1), MAX_ENGAGEMENT_DAYS);
  const query = new URLSearchParams({ days: String(window), ...(repoId ? { repoId } : {}) });
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: PrEngagementResponse }>(`/api/v1/pr-evaluations/engagement?${query}`)
        .then((r) => r.data),
    queryKey: ['pr-engagement', window, repoId ?? null],
    refetchInterval: 60_000,
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
