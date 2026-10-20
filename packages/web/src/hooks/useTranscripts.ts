'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  transcriptHold: boolean;
  runHold: boolean;
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
 * Download a transcript's content stream. The gateway issues a short-lived
 * signed link (a plain navigation carries no Authorization bearer), and the
 * browser then fetches it natively: the attachment's Content-Disposition makes
 * it a download that streams straight to disk, however large the transcript —
 * nothing is buffered in the page.
 */
export async function downloadTranscript(
  id: string,
  format: 'raw' | 'normalized',
  { scrubPii = false }: { scrubPii?: boolean } = {}
): Promise<void> {
  const { url } = await api.post<{ url: string; expiresAt: string }>(
    `/api/v1/transcripts/${id}/download-link`,
    { format, scrubPii }
  );
  const a = document.createElement('a');
  a.href = `${API_BASE}${url}`;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ── Transcript access audit log (ADMIN) ──

export type TranscriptAccessAction =
  | 'content_read'
  | 'download_link'
  | 'export'
  | 'verify'
  | 'legal_hold_set'
  | 'legal_hold_cleared';

export type TranscriptAccessOutcome =
  | 'started'
  | 'ok'
  | 'integrity_error'
  | 'stream_error'
  | 'aborted'
  | 'denied';

export interface TranscriptAccessRow {
  id: string;
  action: TranscriptAccessAction;
  scope: 'transcript' | 'run' | 'export';
  actorId: string | null;
  /** Null when the actor's user row no longer exists. */
  actor: { email: string; name: string | null } | null;
  actorRole: string | null;
  transcriptId: string | null;
  runId: string | null;
  params: Record<string, unknown> | null;
  outcome: TranscriptAccessOutcome;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface TranscriptAccessFilters {
  action?: TranscriptAccessAction;
  actorId?: string;
  transcriptId?: string;
  runId?: string;
  /** ISO instants: `from` inclusive, `to` exclusive. */
  from?: string;
  to?: string;
}

export function useTranscriptAccessLog(
  filters: TranscriptAccessFilters & { limit: number; offset: number }
) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') {
      qs.set(key, String(value));
    }
  }
  return useQuery({
    placeholderData: keepPreviousData,
    queryFn: () =>
      api.get<{ data: TranscriptAccessRow[]; total: number }>(
        `/api/v1/platform/transcripts/access-log?${qs}`
      ),
    queryKey: ['transcript-access-log', filters],
    refetchInterval: 30_000,
  });
}
