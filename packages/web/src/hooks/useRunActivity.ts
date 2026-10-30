'use client';

import type {
  RunActivityFilters,
  RunActivityItem,
  RunActivityPage,
  WorkflowHttpCallDetail,
} from '@auto-swe/shared/types/api';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from '@/lib/api';

function activityUrl(runId: string, filters: RunActivityFilters, suffix = '', cursor?: string) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) {
      qs.set(key, value);
    }
  }
  if (cursor) {
    qs.set('cursor', cursor);
  }
  return `/api/v1/workflow-runs/${runId}/activity${suffix}?${qs}`;
}
export function mergeActivity(...lists: RunActivityItem[][]): RunActivityItem[] {
  return [...new Map(lists.flat().map((item) => [item.id, item])).values()].sort((a, b) =>
    a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
}
interface Tail {
  data: RunActivityItem[];
  cursor?: string;
  since: string;
}
export function useRunActivity(runId: string, filters: RunActivityFilters, live: boolean) {
  const qc = useQueryClient();
  const pages = useInfiniteQuery<RunActivityPage>({
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.get<RunActivityPage>(
        activityUrl(runId, filters, '', typeof pageParam === 'string' ? pageParam : undefined)
      ),
    queryKey: ['run-activity', runId, filters],
    refetchInterval: live ? 30_000 : false,
  });
  const tailKey = ['run-activity-live', runId, filters];
  const tail = useQuery({
    enabled: live && !!pages.data,
    queryFn: async (): Promise<Tail> => {
      const previous = qc.getQueryData<Tail>(tailKey);
      const since = previous?.since ?? new Date(Date.now() - 30_000).toISOString();
      const watermark = new Date(Date.now() - 30_000).toISOString();
      const page = await api.get<RunActivityPage>(
        activityUrl(runId, { ...filters, since }, '', previous?.cursor)
      );
      return {
        cursor: page.nextCursor ?? undefined,
        data: mergeActivity(previous?.data ?? [], page.data),
        since: page.nextCursor ? since : watermark,
      };
    },
    queryKey: tailKey,
    refetchInterval: live ? 3_000 : false,
  });
  const wasLive = useRef(live);
  const refetchPages = pages.refetch;
  const refetchTail = tail.refetch;
  useEffect(() => {
    if (wasLive.current && !live) {
      void refetchPages();
      void refetchTail();
    }
    wasLive.current = live;
  }, [live, refetchPages, refetchTail]);
  return {
    data: mergeActivity(
      ...(pages.data?.pages.map((page) => page.data) ?? []),
      tail.data?.data ?? []
    ),
    error: pages.error ?? tail.error,
    fetchNextPage: pages.fetchNextPage,
    hasNextPage: pages.hasNextPage,
    isFetchingNextPage: pages.isFetchingNextPage,
    isLoading: pages.isLoading,
  };
}
export function useHttpCall(runId: string, callId: string) {
  return useQuery({
    queryFn: () =>
      api
        .get<{ data: WorkflowHttpCallDetail }>(
          `/api/v1/workflow-runs/${runId}/http-calls/${callId}`
        )
        .then((result) => result.data),
    queryKey: ['run-http-call', runId, callId],
  });
}
export async function exportRunActivity(runId: string, filters: RunActivityFilters) {
  const blob = await api.download(activityUrl(runId, filters, '/export'));
  const text = await blob.text();
  const lines = text.trim().split('\n');
  const eof = JSON.parse(lines.at(-1) ?? '{}');
  if (eof.kind !== 'eof' || eof.complete !== true) {
    throw new Error('Activity export was incomplete');
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `run-${runId}-activity.ndjson`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
