'use client';

import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** One step of a connection check, in the order the gateway ran them. */
export interface ProbeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** What a "test this connection" endpoint answers: always 200, with `ok` saying whether it works. */
export interface ProbeResult {
  ok: boolean;
  /** One sentence: the first failure, else every step's detail. */
  detail: string;
  checks: ProbeCheck[];
  durationMs: number;
}

export type HealthStatus = 'ok' | 'failed' | 'skipped';

/** One connection in the "test all" answer. A connection that is not configured is `skipped`. */
export interface HealthEntry {
  id: string;
  group: 'integration' | 'github-host' | 'registry' | 'model-provider';
  label: string;
  status: HealthStatus;
  detail: string;
  durationMs: number;
  /** The page where this connection is configured. */
  href: string;
}

/** Run one connection's check. The caller decides when: a probe spends a request to a remote host. */
export function useProbe(path: string) {
  return useMutation({
    mutationFn: () => api.post<{ data: ProbeResult }>(path, {}).then((r) => r.data),
  });
}

/** Run every stored connection's check. `trackerTicketId` lets the issue tracker be fetched. */
export function useConnectionHealth() {
  return useMutation({
    mutationFn: (trackerTicketId?: string) =>
      api
        .post<{ data: HealthEntry[] }>(
          '/api/v1/platform/connections/test',
          trackerTicketId ? { trackerTicketId } : {}
        )
        .then((r) => r.data),
  });
}
