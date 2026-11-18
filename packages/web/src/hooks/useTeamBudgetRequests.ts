'use client';

import type {
  CreateTeamBudgetRequestBody,
  TeamBudgetRequestSummary,
} from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

const requestsKey = (teamId: string | undefined) => ['team-budget-requests', teamId] as const;

/**
 * The pending requests to change a team's cap. Only a caller who may edit the cap may read them:
 * pass `enabled: false` for anyone else rather than meeting a 403.
 */
export function useTeamBudgetRequests(teamId: string | undefined, enabled = true) {
  return useQuery({
    enabled: !!teamId && enabled,
    queryFn: () =>
      api
        .get<{ data: TeamBudgetRequestSummary[] }>(`/api/v1/teams/${teamId}/budget-requests`)
        .then((r) => r.data),
    queryKey: requestsKey(teamId),
  });
}

/** Ask an admin to change the team's cap, with a reason. */
export function useCreateTeamBudgetRequest(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTeamBudgetRequestBody) =>
      api
        .post<{ data: TeamBudgetRequestSummary }>(`/api/v1/teams/${teamId}/budget-requests`, body)
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: requestsKey(teamId) }),
  });
}

/** Close a pending request without changing the cap, so the lead can ask again. */
export function useDismissBudgetRequest(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (requestId: string) =>
      api
        .post<{ data: { id: string } }>(
          `/api/v1/teams/${teamId}/budget-requests/${requestId}/dismiss`,
          {}
        )
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: requestsKey(teamId) }),
  });
}
