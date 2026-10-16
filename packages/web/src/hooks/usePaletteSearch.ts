'use client';

import type {
  WorkflowRunSummary,
  WorkflowTemplateSummary,
  WorkspaceRequestSummary,
} from '@auto-swe/shared/types/api';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export const PALETTE_SEARCH_DEBOUNCE_MS = 200;
export const PALETTE_SEARCH_MIN_CHARS = 2;
/** Rows asked of each list endpoint, and shown per group. */
export const PALETTE_GROUP_LIMIT = 5;

interface Page<T> {
  data: T[];
}

/** The value after it has stopped changing for `delayMs`. */
function useDebounced(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export interface PaletteSearch {
  /** The query the results below answer; empty until the user has paused typing. */
  settledQuery: string;
  requests: WorkspaceRequestSummary[];
  runs: WorkflowRunSummary[];
  templates: WorkflowTemplateSummary[];
  /** A request is in flight, or the user is still typing past the last one answered. */
  loading: boolean;
}

/**
 * Search the user's work for the command palette: requests, runs and workflow templates, each
 * through the same list endpoint (and so the same visibility rules) its own page uses, with an
 * optional text filter. The query string is part of every query key, so an answer to an earlier
 * query is never shown for a later one; results appear only for the debounced, settled query.
 * A failed request is an empty group — page results never wait on, or break from, the network.
 */
export function usePaletteSearch(rawQuery: string): PaletteSearch {
  const trimmed = rawQuery.trim();
  const settled = useDebounced(trimmed, PALETTE_SEARCH_DEBOUNCE_MS);
  const enabled = settled.length >= PALETTE_SEARCH_MIN_CHARS;
  const common = { enabled, retry: false, staleTime: 30_000 } as const;
  const q = encodeURIComponent(settled);

  const requests = useQuery({
    ...common,
    queryFn: () =>
      api.get<Page<WorkspaceRequestSummary>>(
        `/api/v1/workflow-runs/requests?scope=TEAM&search=${q}&limit=${PALETTE_GROUP_LIMIT}`
      ),
    queryKey: ['palette-search', 'requests', settled],
  });
  const runs = useQuery({
    ...common,
    queryFn: () =>
      api.get<Page<WorkflowRunSummary>>(
        `/api/v1/workflow-runs?q=${q}&limit=${PALETTE_GROUP_LIMIT}`
      ),
    queryKey: ['palette-search', 'runs', settled],
  });
  const templates = useQuery({
    ...common,
    queryFn: () => api.get<Page<WorkflowTemplateSummary>>(`/api/v1/workflow-templates?q=${q}`),
    queryKey: ['palette-search', 'templates', settled],
  });

  // Until the user pauses, `settled` still names an earlier query: show none of its answers.
  const current = enabled && settled === trimmed;
  return {
    loading:
      trimmed.length >= PALETTE_SEARCH_MIN_CHARS &&
      (!current || requests.isFetching || runs.isFetching || templates.isFetching),
    requests: current ? (requests.data?.data ?? []).slice(0, PALETTE_GROUP_LIMIT) : [],
    runs: current ? (runs.data?.data ?? []).slice(0, PALETTE_GROUP_LIMIT) : [],
    settledQuery: settled,
    templates: current ? (templates.data?.data ?? []).slice(0, PALETTE_GROUP_LIMIT) : [],
  };
}
