'use client';

import type { PullRequestCockpit } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';
import { applyViewed, type ViewedChange } from '@/lib/reviewModel';

export const cockpitKey = (id: string) => ['pull-request-cockpit', id] as const;

/** How often an open pull request is read again; a closed or merged one is not. */
export const COCKPIT_POLL_MS = 60_000;

/**
 * Whether, and when, to read the cockpit again. A pull request the host reports as no longer open
 * will not change under the reviewer, so polling it only spends the host's rate limit.
 */
export function cockpitRefetchInterval(data: PullRequestCockpit | undefined): number | false {
  return data?.files.type === 'ok' && data.files.state !== 'open' ? false : COCKPIT_POLL_MS;
}

/**
 * The review page's data. Each read asks the host for the pull request, which is what keeps a
 * reviewer on the head the host reports; the gateway asks conditionally, so a poll that finds
 * nothing changed costs the host's rate limit nothing.
 */
export function usePullRequestCockpit(id: string) {
  return useQuery({
    enabled: id !== '',
    queryFn: () =>
      api
        .get<{ data: PullRequestCockpit }>(`/api/v1/pull-requests/${id}/cockpit`)
        .then((r) => r.data),
    queryKey: cockpitKey(id),
    refetchInterval: (query) => cockpitRefetchInterval(query.state.data),
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
