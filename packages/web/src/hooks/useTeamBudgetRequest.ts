'use client';

import type { TeamBudgetRequestSummary } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// Under the `['team-budget-requests', teamId]` prefix, so sending, dismissing or cancelling a
// request (which invalidate that prefix) refreshes this read too.
const mineKey = (teamId: string | undefined) => ['team-budget-requests', teamId, 'mine'] as const;

/**
 * The team's pending budget request, or null. Readable by whoever may ask for budget
 * (`team.budget-requests.create`); pass `enabled: false` for anyone else.
 */
export function useMyTeamBudgetRequest(teamId: string | undefined, enabled = true) {
  return useQuery({
    enabled: !!teamId && enabled,
    queryFn: () =>
      api
        .get<{ data: TeamBudgetRequestSummary | null }>(
          `/api/v1/teams/${teamId}/budget-requests/mine`
        )
        .then((r) => r.data),
    queryKey: mineKey(teamId),
  });
}

/** Withdraw a pending request, so the requester may ask again. */
export function useCancelBudgetRequest(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (requestId: string) =>
      api
        .post<{ data: { id: string } }>(
          `/api/v1/teams/${teamId}/budget-requests/${requestId}/cancel`,
          {}
        )
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team-budget-requests', teamId] }),
  });
}
