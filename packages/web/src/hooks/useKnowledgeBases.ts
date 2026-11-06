'use client';

import type { resolveKnowledgeBaseSet } from '@auto-swe/shared/lib/knowledgeBaseResolution';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface KnowledgeBaseFields {
  name: string;
  mountName: string;
  description: string;
  path: string;
  defaultRef: string | null;
  visibility: 'TEAM' | 'SHARED' | 'ORG';
  status: 'OK' | 'DISABLED';
}
export interface KnowledgeBase extends KnowledgeBaseFields {
  id: string;
  connectionId: string;
  orgId: string;
  connection?: { teamId: string; team: { id: string; name: string } };
  lastIndexedSha: string | null;
  lastIndexedAt: string | null;
  lastError: string | null;
  shares?: Array<{ teamId: string }>;
  snapshots?: Array<{
    id: string;
    sha: string;
    status: string;
    indexedAt: string | null;
    fileCount: number;
    chunkCount: number;
    bytes: number;
    flaggedFiles: unknown;
    skippedFiles: unknown;
    error: string | null;
  }>;
}
export type KnowledgeBaseTarget =
  | { scope: 'TEAM'; teamId: string }
  | { scope: 'REPO'; repoId: string }
  | { scope: 'TEMPLATE'; templateId: string };
export interface KnowledgeBaseLink {
  id: string;
  knowledgeBaseId: string;
  ref: string | null;
  mountName: string | null;
  mandatory: boolean;
  exclude: boolean;
}
export interface KnowledgeBaseRunOverrides {
  add?: Array<{ id: string; ref?: string }>;
  exclude?: string[];
}
export type KnowledgeBaseSet = ReturnType<typeof resolveKnowledgeBaseSet>;
const BASE = '/api/v1/knowledge-bases';

export function useKnowledgeBases(enabled = true) {
  return useQuery({
    enabled,
    queryFn: () => api.get<{ data: KnowledgeBase[] }>(BASE).then((r) => r.data),
    queryKey: ['knowledge-bases', 'list'],
  });
}
export function useKnowledgeBase(id: string | null, poll = false) {
  return useQuery({
    enabled: !!id,
    queryFn: () => api.get<{ data: KnowledgeBase }>(`${BASE}/${id}`).then((r) => r.data),
    queryKey: ['knowledge-bases', 'detail', id],
    refetchInterval: poll ? 5000 : false,
  });
}
function useInvalidateKnowledgeBases() {
  const qc = useQueryClient();
  return () =>
    Promise.all(
      ['knowledge-bases', 'knowledge-base-links', 'knowledge-base-effective'].map((key) =>
        qc.invalidateQueries({ queryKey: [key] })
      )
    );
}
export function useSaveKnowledgeBase() {
  const invalidate = useInvalidateKnowledgeBases();
  return useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id?: string;
      body: KnowledgeBaseFields & { connectionId?: string };
    }) =>
      (id
        ? api.patch<{ data: KnowledgeBase }>(`${BASE}/${id}`, body)
        : api.post<{ data: KnowledgeBase }>(BASE, body)
      ).then((r) => r.data),
    onSuccess: invalidate,
  });
}
export function useKnowledgeBaseAction() {
  const invalidate = useInvalidateKnowledgeBases();
  return useMutation({
    mutationFn: ({
      id,
      action,
      teamIds,
    }: {
      id: string;
      action: 'delete' | 'reindex' | 'shares';
      teamIds?: string[];
    }) =>
      action === 'delete'
        ? api.delete(`${BASE}/${id}`)
        : action === 'shares'
          ? api.put(`${BASE}/${id}/shares`, { teamIds })
          : api.post(`${BASE}/${id}/reindex`, {}),
    onSuccess: invalidate,
  });
}
export function useKnowledgeBaseLinks(target: KnowledgeBaseTarget, enabled = true) {
  const query = new URLSearchParams(target);
  return useQuery({
    enabled,
    queryFn: () =>
      api
        .get<{ data: KnowledgeBaseLink[] }>(`/api/v1/knowledge-base-links?${query}`)
        .then((r) => r.data),
    queryKey: ['knowledge-base-links', target],
  });
}
export function useWriteKnowledgeBaseLink(target: KnowledgeBaseTarget) {
  const invalidate = useInvalidateKnowledgeBases();
  return useMutation({
    mutationFn: (
      input:
        | { action: 'add'; body: Omit<KnowledgeBaseLink, 'id'> }
        | {
            action: 'update';
            id: string;
            body: Partial<Omit<KnowledgeBaseLink, 'id' | 'knowledgeBaseId'>>;
          }
        | { action: 'delete'; id: string }
    ) =>
      input.action === 'add'
        ? api.post('/api/v1/knowledge-base-links', { ...target, ...input.body })
        : input.action === 'update'
          ? api.patch(`/api/v1/knowledge-base-links/${input.id}`, input.body)
          : api.delete(`/api/v1/knowledge-base-links/${input.id}`),
    onSuccess: invalidate,
  });
}
export function useEffectiveKnowledgeBases({
  repoId,
  teamId,
  templateId,
  enabled = true,
}: {
  repoId?: string | null;
  teamId?: string | null;
  templateId?: string;
  enabled?: boolean;
}) {
  const path = repoId ? `repositories/${repoId}` : `teams/${teamId}`;
  return useQuery({
    enabled: enabled && !!(repoId || teamId),
    queryFn: () =>
      api
        .get<{ data: KnowledgeBaseSet }>(
          `/api/v1/${path}/knowledge-bases/effective${templateId ? `?templateId=${encodeURIComponent(templateId)}` : ''}`
        )
        .then((r) => r.data),
    queryKey: ['knowledge-base-effective', repoId ?? null, teamId ?? null, templateId ?? null],
  });
}
export function knowledgeBaseOverrideBody(value: KnowledgeBaseRunOverrides) {
  return value.add?.length || value.exclude?.length ? { knowledgeBases: value } : {};
}
