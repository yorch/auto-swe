'use client';

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useListQuery } from '@/hooks/useListQuery';
import { api } from '@/lib/api';

export type PrRiskClass = 'LOW' | 'STANDARD' | 'HIGH';
export type PrEvaluationMode = 'off' | 'advisory' | 'enforce' | 'auto';

/** One row of `GET /api/v1/pr-evaluations`: the summary, never the brief itself. */
export interface PrEvaluationRow {
  id: string;
  connectionId: string;
  connection: { organizationName: string | null; repoName: string | null };
  prNumber: number;
  headSha: string;
  baseBranch: string | null;
  riskClass: PrRiskClass;
  mode: string;
  statusState: string;
  requiredApprovers: number;
  autoMergeEnabled: boolean;
  badMerge: boolean;
  badMergeReason: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  triggeredBy: string;
  reasons: unknown;
  briefAvailable: boolean;
  briefMarkdownLength: number;
}

/** `GET /api/v1/pr-evaluations/:id`. The brief is stored as JSON; only its markdown is read. */
export interface PrEvaluationDetail
  extends Omit<PrEvaluationRow, 'briefAvailable' | 'briefMarkdownLength'> {
  brief: unknown;
}

/** `GET /api/v1/repositories/:id/pr-evaluation`, the fields this page draws. */
export interface RepoPrEvaluationPolicy {
  autoMergeAllowed: boolean;
  botApproval: { approverAppConfigured: boolean; enabled: boolean; globalAllowed: boolean };
  enabled: boolean;
  mode: PrEvaluationMode;
  modeSource: 'default' | 'repository';
  requiredStatusContext: string;
  lastEvaluation: {
    id: string;
    prNumber: number;
    riskClass: PrRiskClass;
    statusState: string;
    createdAt: string;
  } | null;
}

export interface PrEvaluationFilters {
  limit: number;
  offset: number;
  repoId?: string;
  riskClass?: PrRiskClass;
  merged?: boolean;
}

export function usePrEvaluations(filters: PrEvaluationFilters) {
  const params = new URLSearchParams({
    limit: String(filters.limit),
    offset: String(filters.offset),
  });
  if (filters.repoId) {
    params.set('repoId', filters.repoId);
  }
  if (filters.riskClass) {
    params.set('riskClass', filters.riskClass);
  }
  if (filters.merged) {
    params.set('merged', 'true');
  }
  const qs = params.toString();
  return useListQuery<PrEvaluationRow>({
    queryFn: () => api.get(`/api/v1/pr-evaluations?${qs}`),
    queryKey: ['pr-evaluations', qs],
    refetchInterval: 30_000,
  });
}

/** The stored brief's markdown, fetched when a row is opened. */
export function usePrEvaluationBrief(id: string | null) {
  return useQuery({
    enabled: id !== null,
    queryFn: () =>
      api.get<{ data: PrEvaluationDetail }>(`/api/v1/pr-evaluations/${id}`).then((r) => r.data),
    queryKey: ['pr-evaluation', id],
  });
}

/** The markdown of a stored brief, or null for a brief of any other shape. */
export function briefMarkdown(brief: unknown): string | null {
  if (brief && typeof brief === 'object' && 'markdown' in brief) {
    const markdown = (brief as { markdown: unknown }).markdown;
    return typeof markdown === 'string' && markdown.length > 0 ? markdown : null;
  }
  return null;
}

export function useRepoPrEvaluationPolicy(repoId: string | undefined) {
  return useQuery({
    enabled: !!repoId,
    queryFn: () =>
      api
        .get<{ data: RepoPrEvaluationPolicy }>(`/api/v1/repositories/${repoId}/pr-evaluation`)
        .then((r) => r.data),
    queryKey: ['repo-pr-evaluation', repoId],
  });
}

/** `mode: null` makes the repository inherit `prEvaluation.defaultMode`. */
export function useSaveRepoPrEvaluation(repoId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { mode?: PrEvaluationMode | null; botApproval?: boolean }) =>
      api.put(`/api/v1/repositories/${repoId}/pr-evaluation`, body),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['repo-pr-evaluation', repoId] });
      void queryClient.invalidateQueries({ queryKey: ['pr-evaluations'] });
    },
  });
}

/**
 * Pull-request ids for evaluations, keyed `<repoId>#<prNumber>`. An evaluation row names its
 * pull request by repository and number only, and the review page is addressed by the pull
 * request's own id, so this reads each visible repository's newest pull requests (one page of
 * 100) and a row whose pull request is older than that has no link.
 */
export function usePullRequestIds(repoIds: string[]): Map<string, string> {
  const unique = [...new Set(repoIds)].sort();
  const results = useQueries({
    queries: unique.map((repoId) => ({
      queryFn: () =>
        api
          .get<{ data: { id: string; prNumber: number | null }[] }>(
            `/api/v1/pull-requests?repoId=${repoId}&scope=TEAM&state=all&limit=100`
          )
          .then((r) => r.data),
      queryKey: ['pull-request-ids', repoId],
      staleTime: 60_000,
    })),
  });
  const ids = new Map<string, string>();
  results.forEach((result, index) => {
    for (const pr of result.data ?? []) {
      if (pr.prNumber !== null) {
        ids.set(`${unique[index]}#${pr.prNumber}`, pr.id);
      }
    }
  });
  return ids;
}
