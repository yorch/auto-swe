'use client';

import type {
  BudgetStatus,
  TeamBudgetSettings,
  UpdateTeamBudgetBody,
} from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * A team's own cap and its month's spend, in dollars. Team ADMIN, ORG_ADMIN of the team's
 * organization, or platform ADMIN only: pass `enabled: false` for anyone else rather than meeting
 * a 403.
 */
export function useTeamBudget(teamId: string | undefined, enabled = true) {
  return useQuery({
    enabled: !!teamId && enabled,
    queryFn: () =>
      api.get<{ data: TeamBudgetSettings }>(`/api/v1/teams/${teamId}/budget`).then((r) => r.data),
    queryKey: ['team-budget', teamId],
  });
}

/** Where the cap that binds this team's work stands; a percentage only, for any team member. */
export function useTeamBudgetStatus(teamId: string | undefined, enabled = true) {
  return useQuery({
    enabled: !!teamId && enabled,
    queryFn: () =>
      api.get<{ data: BudgetStatus }>(`/api/v1/teams/${teamId}/budget/status`).then((r) => r.data),
    queryKey: ['team-budget-status', teamId],
  });
}

/** Set or clear (`null`) the team's cap and alert threshold. */
export function useUpdateTeamBudget(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateTeamBudgetBody) =>
      api
        .patch<{ data: TeamBudgetSettings }>(`/api/v1/teams/${teamId}/budget`, body)
        .then((r) => r.data),
    onSuccess: () => {
      for (const queryKey of [
        ['team-budget', teamId],
        ['team-budget-status', teamId],
        ['team-overview', teamId],
        ['teams'],
        ['me-summary'],
      ]) {
        void qc.invalidateQueries({ queryKey });
      }
    },
  });
}
