'use client';

import type { RunActivityPage } from '@auto-swe/shared/types/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from '@/lib/api';

/** How often a running lane re-reads its latest tool call. */
export const LATEST_TOOL_CALL_POLL_MS = 10_000;
const PAGE_SIZE = 500;
const MAX_PAGES = 10;

export interface LatestToolCall {
  id: string;
  summary: string;
  ts: string;
}

/**
 * The newest tool call of a run. The activity feed is oldest first with no way to ask for the
 * end, so this follows the cursor to the last page and keeps the last item; a poll then asks
 * only for what came after the newest call already held. `poll` is true only for a running
 * lane: a finished run is read once, with one last read when it stops.
 */
export function useLatestToolCall(runId: string | null, poll: boolean) {
  const qc = useQueryClient();
  const query = useQuery<LatestToolCall | null>({
    enabled: !!runId,
    queryFn: async () => {
      const held = qc.getQueryData<LatestToolCall | null>(['run-latest-tool-call', runId]);
      let latest = held ?? null;
      let cursor: string | undefined;
      for (let pages = 0; pages < MAX_PAGES; pages += 1) {
        const qs = new URLSearchParams({ kinds: 'tool_call', limit: String(PAGE_SIZE) });
        if (held) {
          qs.set('since', held.ts);
        }
        if (cursor) {
          qs.set('cursor', cursor);
        }
        const page = await api.get<RunActivityPage>(
          `/api/v1/workflow-runs/${encodeURIComponent(runId ?? '')}/activity?${qs}`
        );
        const last = page.data.at(-1);
        if (last) {
          latest = { id: last.id, summary: last.summary, ts: last.ts };
        }
        if (!page.nextCursor) {
          break;
        }
        cursor = page.nextCursor;
      }
      return latest;
    },
    queryKey: ['run-latest-tool-call', runId],
    refetchInterval: poll ? LATEST_TOOL_CALL_POLL_MS : false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const wasPolling = useRef(poll);
  const refetch = query.refetch;
  useEffect(() => {
    if (wasPolling.current && !poll) {
      void refetch();
    }
    wasPolling.current = poll;
  }, [poll, refetch]);
  return query;
}
