'use client';

import type {
  CreateFailureAssignmentBody,
  FailureAssignmentResult,
  HumanStepNudgeResult,
  TeamAttentionFailure,
} from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApprovals } from '@/hooks/useApprovals';
import { ME_SUMMARY_KEY } from '@/hooks/useMeSummary';
import { api } from '@/lib/api';

const failuresKey = (teamId: string) => ['team-attention-failures', teamId] as const;

/** Failures on the team's work with no owner. Team LEAD or ADMIN only. */
export function useTeamAttentionFailures(teamId: string | undefined) {
  return useQuery({
    enabled: !!teamId,
    queryFn: () =>
      api
        .get<{ data: TeamAttentionFailure[] }>(`/api/v1/teams/${teamId}/attention/failures`)
        .then((r) => r.data),
    queryKey: failuresKey(teamId ?? ''),
  });
}

/** The team's pending steps whose deadline has passed. */
export function useTeamStaleApprovals(teamId: string | undefined) {
  return useApprovals('PENDING', 'requestedAt:desc', true, undefined, false, {
    enabled: !!teamId,
    teamId,
  });
}

/** Give an unowned failure to a member of the team. */
export function useAssignFailure(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateFailureAssignmentBody) =>
      api
        .post<{ data: FailureAssignmentResult }>(
          `/api/v1/teams/${teamId}/failure-assignments`,
          body
        )
        .then((r) => r.data),
    onSuccess: () => {
      for (const queryKey of [failuresKey(teamId), ['team-overview', teamId], ME_SUMMARY_KEY]) {
        void qc.invalidateQueries({ queryKey });
      }
    },
  });
}

/** Reply in the Slack thread of a pending step's announcement. */
export function useNudgeHumanStep() {
  return useMutation({
    mutationFn: (stepId: string) =>
      api
        .post<{ data: HumanStepNudgeResult }>(`/api/v1/human-steps/${stepId}/nudge`, {})
        .then((r) => r.data),
  });
}
