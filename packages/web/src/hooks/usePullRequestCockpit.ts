'use client';

import type { PullRequestCockpit } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';
import { applyViewed, type ViewedChange } from '@/lib/reviewModel';

export const cockpitKey = (id: string) => ['pull-request-cockpit', id] as const;

/**
 * The review page's data. Each read asks the host for the files, which is what keeps a reviewer on
 * the head the host reports, so it polls slowly: the gateway answers a repeat of one head from a
 * short-lived copy, but it still asks the host which head that is.
 */
export function usePullRequestCockpit(id: string) {
  return useQuery({
    enabled: id !== '',
    queryFn: () =>
      api
        .get<{ data: PullRequestCockpit }>(`/api/v1/pull-requests/${id}/cockpit`)
        .then((r) => r.data),
    queryKey: cockpitKey(id),
    refetchInterval: 30_000,
    // A pull request that is not there, or not theirs to see, will not appear on a retry.
    retry: (failures, error) =>
      !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failures < 2,
  });
}

/**
 * Mark files viewed, or clear the marks. The change shows at once and is put back if the gateway
 * refuses it; it is not re-read on success, because that read would ask the host again for nothing
 * the reviewer has not already been shown.
 */
export function useSetFilesViewed(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (change: ViewedChange) =>
      api.put<{ data: { updated: number } }>(`/api/v1/pull-requests/${id}/viewed`, change),
    onError: (_error, _change, previous) => {
      if (previous) {
        qc.setQueryData(cockpitKey(id), previous);
      }
    },
    onMutate: async (change) => {
      await qc.cancelQueries({ queryKey: cockpitKey(id) });
      const previous = qc.getQueryData<PullRequestCockpit>(cockpitKey(id));
      if (previous) {
        qc.setQueryData<PullRequestCockpit>(cockpitKey(id), {
          ...previous,
          viewed: applyViewed(previous.viewed, change),
        });
      }
      return previous;
    },
  });
}
