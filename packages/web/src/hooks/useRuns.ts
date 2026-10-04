'use client';

import type {
  AgentTraceRecord,
  AutonomyDecisionDto,
  EvalResultDto,
  RetryWorkRequestResponse,
  WorkflowDetail,
  WorkflowRunDetail,
  WorkflowRunSummary,
  WorkflowSummary,
} from '@auto-swe/shared/types/api';
import { isTerminalWorkflowRunStatus } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { type ListOptions, listUrl, useListQuery } from '@/hooks/useListQuery';
import { api } from '@/lib/api';

export function useWorkflows(opts: ListOptions = {}) {
  return useListQuery<WorkflowSummary>({
    queryFn: () => api.get(listUrl('/api/v1/workflows', opts)),
    queryKey: ['workflows', opts],
    refetchInterval: 10_000,
  });
}

export function useWorkflow(id: string) {
  return useQuery({
    enabled: !!id,
    queryFn: () => api.get<{ data: WorkflowDetail }>(`/api/v1/workflows/${id}`).then((r) => r.data),
    queryKey: ['workflow', id],
    refetchInterval: 5_000,
  });
}

/**
 * How far behind its base the live-tail cursor sits. A trace's `createdAt` is
 * the writing worker's clock, at millisecond precision, when it built the
 * insert — not when the row committed. A slow insert (a large batch, a wait
 * for a pool connection) or a worker whose clock lags can therefore commit a
 * row older than one already read. The overlap catches the common case
 * cheaply; the trace count (see `useWorkflowRun`) catches the rest.
 */
export const TRACE_TAIL_OVERLAP_MS = 10_000;

/**
 * The `since` cursor for the next live-tail poll, or null to read every trace.
 * Its base is the server time of the previous tail read when there is one,
 * otherwise the newest trace held. Basing it on the newest trace alone would
 * re-download the last batch on every poll for as long as a run stays idle;
 * from the last read, an idle run's poll returns nothing once the overlap has
 * passed.
 */
export function traceTailCursor(
  traces: readonly AgentTraceRecord[],
  lastReadAt?: string
): string | null {
  let base = lastReadAt ? Date.parse(lastReadAt) : Number.NEGATIVE_INFINITY;
  if (!Number.isFinite(base)) {
    for (const t of traces) {
      base = Math.max(base, Date.parse(t.createdAt));
    }
  }
  return Number.isFinite(base) ? new Date(base - TRACE_TAIL_OVERLAP_MS).toISOString() : null;
}

/** A run as the run page caches it: plus when its traces were last tailed. */
export type LiveWorkflowRunDetail = WorkflowRunDetail & {
  /** Server time of the last live-tail read, the next cursor's base. */
  tracesReadAt?: string;
};

/**
 * Append newly read traces, dropping ones already held, in the server's order
 * (`createdAt`, then `seq`). The sort is stable, so ties keep their order.
 */
export function mergeTraces(
  held: readonly AgentTraceRecord[],
  incoming: readonly AgentTraceRecord[]
): AgentTraceRecord[] {
  const seen = new Set(held.map((t) => t.id));
  const fresh = incoming.filter((t) => !seen.has(t.id));
  if (fresh.length === 0) {
    return held as AgentTraceRecord[];
  }
  return [...held, ...fresh].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.seq - b.seq
  );
}

/**
 * `fullTraces` skips the server's 4 000-char trim of trace payloads. It is
 * opt-in, and fetched once rather than polled: full prompts run to tens of KB
 * each, and re-downloading all of them every few seconds is the cost the trim
 * exists to avoid.
 *
 * The trimmed view loads every trace once, then each poll reads the run
 * without traces (status, steps, totals) and only the traces created since the
 * newest one held, appending them to the cached run. No cursor can promise that
 * every row behind it has been read (see `TRACE_TAIL_OVERLAP_MS`), so the tail
 * also reports how many traces the run has: when the merged set does not match
 * that count, the poll re-reads every (trimmed) trace instead. It does the same
 * once when the run turns terminal, so the finished run is never left short.
 */
export function useWorkflowRun(id: string, includeTraces = true, fullTraces = false) {
  const qc = useQueryClient();
  const param = fullTraces ? 'fullTraces=true' : includeTraces ? 'includeTraces=true' : '';
  const queryKey = ['workflow-run', id, includeTraces, fullTraces];
  return useQuery<LiveWorkflowRunDetail>({
    enabled: !!id,
    // Switching to full payloads must not blank the page while it refetches —
    // but only for the same run, or the previous run would flash on navigation.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === id ? prev : undefined),
    queryFn: async () => {
      const held = qc.getQueryData<LiveWorkflowRunDetail>(queryKey);
      // A run's spec is fixed when it starts, so once held it is not fetched
      // again: the read skips it and the held copy is carried over.
      const withHeldSpec = (run: WorkflowRunDetail): WorkflowRunDetail =>
        held ? { ...run, specSnapshot: held.specSnapshot } : run;
      const runUrl = (extra = '') => {
        const qs = [extra, held ? 'includeSpec=false' : ''].filter(Boolean).join('&');
        return `/api/v1/workflow-runs/${id}${qs ? `?${qs}` : ''}`;
      };
      const readAll = () =>
        api.get<{ data: WorkflowRunDetail }>(runUrl(param)).then((r) => withHeldSpec(r.data));
      if (fullTraces || !includeTraces || !held) {
        return readAll();
      }
      const heldTraces = held.traces ?? [];
      const since = traceTailCursor(heldTraces, held.tracesReadAt);
      const [run, tail] = await Promise.all([
        api.get<{ data: WorkflowRunDetail }>(runUrl()),
        api.get<{ data: AgentTraceRecord[]; serverTime: string; total: number }>(
          `/api/v1/workflow-runs/${id}/traces${since ? `?since=${encodeURIComponent(since)}` : ''}`
        ),
      ]);
      const traces = mergeTraces(heldTraces, tail.data);
      const justFinished =
        isTerminalWorkflowRunStatus(run.data.status) && !isTerminalWorkflowRunStatus(held.status);
      // The tail's server time precedes the full read too, so either way it is
      // a safe base for the next cursor.
      const tracesReadAt = tail.serverTime;
      if (traces.length !== tail.total || justFinished) {
        return { ...(await readAll()), tracesReadAt };
      }
      return { ...withHeldSpec(run.data), traces, tracesReadAt };
    },
    queryKey,
    refetchInterval: (q) => {
      if (fullTraces) {
        return false;
      }
      const data = q.state.data;
      return data && !isTerminalWorkflowRunStatus(data.status) ? 3_000 : 30_000;
    },
  });
}

/**
 * The run page's trace-payload mode. A full-payload response can run to many
 * MB, so it can fail where the trimmed one did not; when it does, fall back to
 * the trimmed view. The fallback is made while rendering (React's "adjust state
 * during render"), so the failed query's `isError` is never committed — an
 * effect would let the page paint its load-error branch for a frame first.
 */
export function useRunDetail(id: string) {
  const [fullTraces, setFullTraces] = useState(false);
  const [fullTracesFailed, setFullTracesFailed] = useState(false);
  const query = useWorkflowRun(id, true, fullTraces);
  if (fullTraces && query.isError) {
    setFullTraces(false);
    setFullTracesFailed(true);
  }
  const toggleFullTraces = () => {
    setFullTracesFailed(false);
    setFullTraces((v) => !v);
  };
  // Named fields only: spreading the query result reads every property, which
  // opts the page out of tracked re-renders and re-renders it on each poll.
  return {
    data: query.data,
    error: query.error,
    fullTraces,
    fullTracesFailed,
    isError: query.isError,
    isLoading: query.isLoading,
    isPlaceholderData: query.isPlaceholderData,
    toggleFullTraces,
  };
}

/** P0 evals: captured quality signals (gate / review / merge) for a run. */
export function useEvalResultsForRun(runId?: string) {
  return useQuery({
    enabled: !!runId,
    queryFn: () =>
      api
        .get<{ data: EvalResultDto[] }>(`/api/v1/workflow-runs/${runId}/eval-results`)
        .then((r) => r.data),
    queryKey: ['eval-results', runId],
    refetchInterval: 10_000,
  });
}

/** P3 governance: autonomy decisions for a run. */
export function useAutonomyDecisionsForRun(runId?: string) {
  return useQuery({
    enabled: !!runId,
    queryFn: () =>
      api
        .get<{ data: AutonomyDecisionDto[] }>(`/api/v1/workflow-runs/${runId}/autonomy-decisions`)
        .then((r) => r.data),
    queryKey: ['autonomy-decisions', runId],
    refetchInterval: 10_000,
  });
}

export function useAllWorkflowRuns(
  filters: {
    status?: string;
    templateId?: string;
    templateVersion?: number;
    /** Only runs in which this spec node failed. */
    failedNodeId?: string;
    scope?: 'ALL' | 'MINE' | 'TEAM';
    limit?: number;
    offset?: number;
    includeChannel?: boolean;
  } = {}
) {
  const params = new URLSearchParams();
  if (filters.status) {
    params.set('status', filters.status);
  }
  if (filters.templateId) {
    params.set('templateId', filters.templateId);
  }
  if (filters.templateVersion) {
    params.set('templateVersion', String(filters.templateVersion));
  }
  if (filters.failedNodeId) {
    params.set('failedNodeId', filters.failedNodeId);
  }
  if (filters.scope) {
    params.set('scope', filters.scope);
  }
  if (filters.includeChannel) {
    params.set('includeChannel', 'true');
  }
  params.set('limit', String(filters.limit ?? 50));
  params.set('offset', String(filters.offset ?? 0));
  return useQuery({
    queryFn: () =>
      api
        .get<{
          data: WorkflowRunSummary[];
          meta: { limit: number; offset: number; total: number };
        }>(`/api/v1/workflow-runs?${params.toString()}`)
        .then((r) => ({ data: r.data, meta: r.meta })),
    queryKey: ['workflow-runs', filters],
    refetchInterval: 10_000,
  });
}

export function useRunsForWorkRequest(workRequestId?: string | null, limit = 20) {
  return useQuery({
    enabled: !!workRequestId,
    queryFn: () =>
      api
        .get<{ data: WorkflowRunSummary[] }>(
          `/api/v1/workflow-runs?workRequestId=${workRequestId}&limit=${limit}&offset=0`
        )
        .then((r) => r.data),
    queryKey: ['workflow-runs', 'by-work-request', workRequestId, limit],
    refetchInterval: 10_000,
  });
}

export function useCancelWorkflowRun(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`/api/v1/workflow-runs/${runId}/cancel`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflow-run', runId] });
      qc.invalidateQueries({ queryKey: ['workflow-runs'] });
      qc.invalidateQueries({ queryKey: ['workflows'] });
    },
  });
}

export function useRetryWorkRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: string | { workRequestId: string; instructions?: string }) => {
      const workRequestId = typeof input === 'string' ? input : input.workRequestId;
      return api
        .post<{ data: RetryWorkRequestResponse }>(
          `/api/v1/work-requests/${workRequestId}/retry`,
          typeof input === 'string' ? {} : { instructions: input.instructions }
        )
        .then((response) => response.data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflows'] });
      qc.invalidateQueries({ queryKey: ['workflow-runs'] });
    },
  });
}

/** How long to look for a re-run's WorkflowRun row before giving up on it. */
export const RETRIED_RUN_WAIT_MS = 60_000;
const RETRIED_RUN_POLL_MS = 2_000;

/**
 * Finds the run a re-run started. The worker creates the WorkflowRun row once
 * the workflow begins, so right after the retry call it does not exist yet: poll
 * the work request's runs for the one keyed by the Temporal workflow id, for a
 * bounded time. `timedOut` lets the caller fall back to a generic link.
 */
export function useRetriedRun(workRequestId: string | null, workflowId: string | null) {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setTimedOut(false);
    if (!workflowId) {
      return;
    }
    const timer = setTimeout(() => setTimedOut(true), RETRIED_RUN_WAIT_MS);
    return () => clearTimeout(timer);
  }, [workflowId]);

  const { data: runId } = useQuery({
    enabled: !!workRequestId && !!workflowId && !timedOut,
    queryFn: () =>
      api
        .get<{ data: WorkflowRunSummary[] }>(
          `/api/v1/workflow-runs?workRequestId=${workRequestId}&limit=20&offset=0`
        )
        .then((r) => r.data),
    queryKey: ['workflow-runs', 'retried', workRequestId, workflowId],
    refetchInterval: (q) =>
      q.state.data?.some((r) => r.workflowId === workflowId) ? false : RETRIED_RUN_POLL_MS,
    select: (runs) => runs.find((r) => r.workflowId === workflowId)?.id ?? null,
  });
  return { runId: runId ?? null, timedOut: timedOut && !runId };
}
