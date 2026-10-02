'use client';

import type {
  AgentRunAgent,
  AgentRunLaunchResponse,
  AgentRunLimits,
} from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { newIdempotencyKey } from '@/lib/agentRun';
import { api } from '@/lib/api';

/** The query string for the form-support reads: scoped to a repository when one is chosen. */
function repoQuery(repoId: string | null): string {
  return repoId ? `?repoId=${encodeURIComponent(repoId)}` : '';
}

/**
 * Launchable agents. Re-read per repository: an organization's override of an
 * agent applies to repositories of that organization only.
 */
export function useAgentRunAgents(repoId: string | null) {
  return useQuery({
    // The list depends on the repository (organization overrides); without one there is
    // nothing to offer, so do not fetch.
    enabled: repoId !== null,
    queryFn: () =>
      api
        .get<{ data: AgentRunAgent[] }>(`/api/v1/agent-runs/agents${repoQuery(repoId)}`)
        .then((r) => r.data),
    queryKey: ['agent-run-agents', repoId],
  });
}

export function useAgentRunLimits(repoId: string | null) {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: AgentRunLimits }>(`/api/v1/agent-runs/limits${repoQuery(repoId)}`)
        .then((r) => r.data),
    queryKey: ['agent-run-limits', repoId],
  });
}

function invalidateRuns(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['workflows'] });
  qc.invalidateQueries({ queryKey: ['workflow-runs'] });
}

export function useLaunchAgentRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      body,
      idempotencyKey,
    }: {
      body: Record<string, unknown>;
      idempotencyKey: string;
    }) =>
      api
        .fetch<{ data: AgentRunLaunchResponse }>('/api/v1/agent-runs', {
          body: JSON.stringify(body),
          headers: { 'Idempotency-Key': idempotencyKey },
          method: 'POST',
        })
        .then((r) => r.data),
    onSuccess: () => invalidateRuns(qc),
  });
}

/**
 * Re-run an agent run as a new one. Not `useRetryWorkRequest`: the generic retry
 * answers `409 USE_AGENT_RUN_RERUN` for an agent run.
 */
export function useRerunAgentRun() {
  const qc = useQueryClient();
  return useMutation({
    // A fresh key per confirmed re-run: it is a new run by intent, never a retry of one.
    mutationFn: (workRequestId: string) =>
      api
        .fetch<{ data: AgentRunLaunchResponse }>(`/api/v1/agent-runs/${workRequestId}/rerun`, {
          body: JSON.stringify({}),
          headers: { 'Idempotency-Key': newIdempotencyKey() },
          method: 'POST',
        })
        .then((r) => r.data),
    onSuccess: () => invalidateRuns(qc),
  });
}
