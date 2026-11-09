'use client';

import type { WorkflowRunSummary } from '@auto-swe/shared/types/api';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * The runs list with the gateway's text filter (`q`, over the request's title, description and
 * ticket and the workflow's name) and ownership scope. The query key starts with `workflow-runs`,
 * so every invalidation of that key refreshes this list too.
 */
export function useRunsSearch(
  filters: {
    includeChannel: boolean;
    limit: number;
    offset: number;
    q: string;
    scope?: 'MINE';
    status?: string;
    templateId?: string;
    /** Narrow to one team's work (`?team=`); omit for every team. */
    teamId?: string;
  },
  options: { enabled?: boolean } = {}
) {
  const params = new URLSearchParams();
  if (filters.status) {
    params.set('status', filters.status);
  }
  if (filters.templateId) {
    params.set('templateId', filters.templateId);
  }
  if (filters.q.trim()) {
    params.set('q', filters.q.trim());
  }
  if (filters.scope) {
    params.set('scope', filters.scope);
  }
  if (filters.teamId) {
    params.set('teamId', filters.teamId);
  }
  if (filters.includeChannel) {
    params.set('includeChannel', 'true');
  }
  params.set('limit', String(filters.limit));
  params.set('offset', String(filters.offset));
  return useQuery({
    enabled: options.enabled ?? true,
    // Typing in the search box must not blank the table between keystrokes.
    placeholderData: (previous) => previous,
    queryFn: () =>
      api
        .get<{
          data: WorkflowRunSummary[];
          meta: { limit: number; offset: number; total: number };
        }>(`/api/v1/workflow-runs?${params.toString()}`)
        .then((r) => ({ data: r.data, meta: r.meta })),
    queryKey: ['workflow-runs', 'search', filters],
    refetchInterval: 10_000,
  });
}
