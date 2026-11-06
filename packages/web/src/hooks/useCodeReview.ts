'use client';

import type {
  ReviewPresetCreateInput,
  ReviewPresetUpdateInput,
} from '@auto-swe/shared/lib/codeReview';
import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import type { ListPage } from '@/hooks/useListQuery';
import { api } from '@/lib/api';
import { randomId } from '@/lib/randomId';

export interface ReviewChoice {
  id: string;
  name: string;
}
export interface ReviewAttachment {
  id: string;
  templateId: string | null;
  connectionId: string | null;
}
export interface ReviewPreset extends ReviewChoice {
  description: string;
  templateId: string;
  systemPrompt: string | null;
  onBlocking: 'report' | 'fix';
  enabled: boolean;
  attachments: ReviewAttachment[];
  template: ReviewChoice;
}
const base = '/api/v1/platform/review-presets';
export function useReviewChoices(enabled = true) {
  return useQuery({
    enabled,
    queryFn: () =>
      api.get<{ data: (ReviewChoice & { description: string })[]; templates: ReviewChoice[] }>(
        '/api/v1/review-presets'
      ),
    queryKey: ['review-choices'],
  });
}
export function useRunReview(runId: string) {
  const qc = useQueryClient();
  const submission = useRef<{ body: string; key: string } | null>(null);
  return useMutation({
    mutationFn: (choice: { presetId: string } | { templateId: string }) => {
      const body = JSON.stringify(choice);
      if (submission.current?.body !== `${runId}:${body}`) {
        submission.current = { body: `${runId}:${body}`, key: randomId() };
      }
      return api
        .fetch<{ data: { runId: string; workflowId: string } }>(
          `/api/v1/workflow-runs/${runId}/reviews`,
          { body, headers: { 'Idempotency-Key': submission.current.key }, method: 'POST' }
        )
        .then((r) => r.data);
    },
    onSuccess: () => {
      submission.current = null;
      qc.invalidateQueries({ queryKey: ['workflow-run', runId] });
    },
  });
}
export function useRetryReviewFix(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`/api/v1/workflow-runs/${runId}/reviews/fix-retry`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflow-run', runId] });
    },
  });
}
export function useReviewPresets() {
  return useQuery({
    queryFn: () => api.get<{ data: ReviewPreset[] }>(base).then((r) => r.data),
    queryKey: ['review-presets'],
  });
}
export function useSaveReviewPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id?: string;
      body: ReviewPresetCreateInput | ReviewPresetUpdateInput;
    }) => (id ? api.patch(`${base}/${id}`, body) : api.post(base, body)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['review-presets'] });
      qc.invalidateQueries({ queryKey: ['review-choices'] });
    },
  });
}
export function useDeleteReviewPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`${base}/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['review-presets'] });
      qc.invalidateQueries({ queryKey: ['review-choices'] });
    },
  });
}
export function useReviewAttachment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      target,
      remove,
    }: {
      id: string;
      target: { templateId: string } | { connectionId: string };
      remove?: boolean;
    }) =>
      api.fetch(`${base}/${id}/attachments`, {
        body: JSON.stringify(target),
        method: remove ? 'DELETE' : 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['review-presets'] }),
  });
}
export function useReviewRepositories() {
  return useQuery({
    queryFn: async () => {
      const rows: RepositorySummary[] = [];
      for (;;) {
        const page = await api.get<ListPage<RepositorySummary>>(
          `/api/v1/repositories?includeInactive=true&limit=200&offset=${rows.length}`
        );
        rows.push(...page.data);
        if (!page.data.length || rows.length >= page.meta.total) {
          return rows.filter((r) => r.type === 'git_repo');
        }
      }
    },
    queryKey: ['review-repositories'],
  });
}
