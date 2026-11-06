'use client';

import type { PullRequestCockpit } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';
import { applyViewed, restoreViewed, type ViewedChange } from '@/lib/reviewModel';

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
 * Note that the caller has now seen this head, so the next visit can say what moved since. Best
 * effort: a failure costs the next visit its summary and nothing else. It never re-reads the
 * cockpit, which would answer without the summary the page is showing.
 */
export function useRecordVisit(id: string) {
  return useMutation({
    mutationFn: (headSha: string) =>
      api.post<{ data: { recorded: boolean } }>(`/api/v1/pull-requests/${id}/visit`, { headSha }),
  });
}

const viewedKey = (id: string) => ['pull-request-viewed', id] as const;

/**
 * Mark files viewed, or clear the marks. The change shows at once. If the gateway refuses it, only
 * the paths it named are put back, so a later change that did succeed is kept.
 *
 * A success is not re-read, because that read would carry every patch again for nothing the reviewer
 * has not already been shown. The one exception is a read already in flight when the last change
 * settles: it may have been answered before the change was stored, and would put the old marks back,
 * so it is replaced by a fresh one.
 */
export function useSetFilesViewed(id: string) {
  const qc = useQueryClient();
  return useMutation<
    { data: { updated: number } },
    Error,
    ViewedChange,
    { before: ReadonlySet<string> } | undefined
  >({
    mutationFn: (change: ViewedChange) =>
      api.put<{ data: { updated: number } }>(`/api/v1/pull-requests/${id}/viewed`, change),
    mutationKey: viewedKey(id),
    onError: (_error, change, context) => {
      if (!context) {
        return;
      }
      qc.setQueryData<PullRequestCockpit>(cockpitKey(id), (current) =>
        current
          ? {
              ...current,
              viewed: restoreViewed(
                current.viewed,
                change.files.map((f) => f.path),
                context.before
              ),
            }
          : current
      );
    },
    onMutate: async (change) => {
      await qc.cancelQueries({ queryKey: cockpitKey(id) });
      const previous = qc.getQueryData<PullRequestCockpit>(cockpitKey(id));
      if (!previous) {
        return undefined;
      }
      qc.setQueryData<PullRequestCockpit>(cockpitKey(id), {
        ...previous,
        viewed: applyViewed(previous.viewed, change),
      });
      return { before: new Set(previous.viewed) };
    },
    onSettled: () => {
      // Still counted while its own callback runs, so "the last one" is a count of one.
      const lastOne = qc.isMutating({ mutationKey: viewedKey(id) }) <= 1;
      if (lastOne && qc.isFetching({ queryKey: cockpitKey(id) }) > 0) {
        void qc.invalidateQueries({ queryKey: cockpitKey(id) });
      }
    },
  });
}
