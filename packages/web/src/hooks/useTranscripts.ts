'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { API_BASE } from '@/lib/config';

export interface TranscriptMeta {
  activityOutcome: string | null;
  activityType: string;
  agentKeys: string[];
  attempt: number;
  closedAt: string | null;
  createdAt: string;
  id: string;
  legalHold: boolean;
  modelCallCount: number;
  runId: string | null;
  runtime: string;
  sha256: string | null;
  sizeBytes: number;
  status: string;
  workflowId: string;
}

export function useRunTranscripts(runId: string) {
  return useQuery({
    enabled: !!runId,
    queryFn: () =>
      api
        .get<{ data: TranscriptMeta[] }>(`/api/v1/workflow-runs/${runId}/transcripts`)
        .then((r) => r.data),
    queryKey: ['run-transcripts', runId],
  });
}

export function useTranscriptLegalHold(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { held: boolean; reason?: string }) =>
      input.held
        ? api.put(`/api/v1/workflow-runs/${runId}/transcripts/legal-hold`, {
            reason: input.reason,
          })
        : api.delete(`/api/v1/workflow-runs/${runId}/transcripts/legal-hold`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['run-transcripts', runId] });
    },
  });
}

/**
 * Download a transcript's content stream. A plain <a href> navigation does not
 * carry the Authorization bearer the gateway needs, so the body is fetched
 * through the same credentials path as `api` and handed to the browser as a
 * blob — the same pattern as the audit-log export.
 */
export async function downloadTranscript(id: string, format: 'raw' | 'normalized'): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/transcripts/${id}/content?format=${format}`, {
    credentials: 'include',
  });
  if (!res.ok) {
    throw new Error(`Transcript download failed: HTTP ${res.status}`);
  }
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.download = `transcript-${id}-${format}.ndjson`;
  a.href = href;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}
