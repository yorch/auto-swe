'use client';

import type { WorkflowRunSummary, WorkspaceRequestSummary } from '@auto-swe/shared/types/api';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useTeamStore } from '@/stores/teamStore';

export type RequestScope = 'MINE' | 'TEAM';
export type RequestState = 'all' | 'active' | 'attention' | 'finished' | 'failed' | 'success';
interface Page<T> {
  data: T[];
  meta: { total: number; limit: number; offset: number };
}

export function useRequests(
  filters: {
    scope: RequestScope;
    requestId?: string;
    state?: RequestState;
    search?: string;
    offset?: number;
    limit?: number;
  },
  options: { enabled?: boolean } = {}
) {
  const teamId = useTeamStore((state) => state.selectedTeamId);
  const scoped = { ...filters, ...(teamId ? { teamId } : {}) };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(scoped)) {
    if (value !== undefined && value !== '') {
      params.set(key, String(value));
    }
  }
  return useQuery({
    enabled: options.enabled ?? true,
    queryFn: () =>
      api.get<Page<WorkspaceRequestSummary>>(`/api/v1/workflow-runs/requests?${params}`),
    queryKey: ['workflow-runs', 'requests', scoped],
    refetchInterval: 10_000,
  });
}

export function useRequestAttempts(requestId: string, offset = 0) {
  return useQuery({
    queryFn: () =>
      api.get<Page<WorkflowRunSummary>>(
        `/api/v1/workflow-runs?workRequestId=${encodeURIComponent(requestId)}&limit=20&offset=${offset}`
      ),
    queryKey: ['workflow-runs', 'request-attempts', requestId, offset],
    refetchInterval: 5_000,
  });
}
