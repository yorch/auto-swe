'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type KnowledgeStatus = 'UNREVIEWED' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED';
export type KnowledgeType = 'LEARNING' | 'REFERENCE' | 'DECISION' | 'POLICY';
export type KnowledgeVisibility = 'REPOSITORY' | 'TEAM' | 'SELECTED_TEAMS' | 'ORGANIZATION';
export interface KnowledgeItem {
  id: string;
  type: KnowledgeType;
  status: KnowledgeStatus;
  visibility: KnowledgeVisibility;
  title: string;
  content: string;
  version: number;
  createdAt: string;
  trustLabel: string;
  provenance?: {
    producerRunId: string | null;
    producerNodeId: string | null;
    producerAgentKey: string | null;
    modelSpec: string | null;
    evidence: unknown[];
  } | null;
}
export interface KnowledgePermissions {
  canCreateCurated: boolean;
  canManageTeam: boolean;
  canPublishOrganization: boolean;
  canPublishSelectedTeams: boolean;
  platformAdmin: boolean;
  repoOriginActionsRequireSourceAccess: true;
}
const root = '/api/v1/knowledge';
const invalidate = (qc: ReturnType<typeof useQueryClient>) =>
  qc.invalidateQueries({ queryKey: ['knowledge'] });
export function useKnowledge(params: {
  q?: string;
  status?: string;
  type?: string;
  offset?: number;
  view?: 'read' | 'review';
}) {
  return useQuery({
    queryFn: () => {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== '') {
          search.set(key, String(value));
        }
      }
      return api.get<{ data: KnowledgeItem[]; meta: { returned: number; searchMode?: string } }>(
        `${root}?${search}`
      );
    },
    queryKey: ['knowledge', params],
  });
}
export function useKnowledgePermissions(teamId?: string, orgId?: string) {
  return useQuery({
    enabled: !!teamId || !!orgId,
    queryFn: () => {
      const search = new URLSearchParams();
      if (teamId) {
        search.set('teamId', teamId);
      }
      if (orgId) {
        search.set('orgId', orgId);
      }
      return api
        .get<{ data: KnowledgePermissions }>(`${root}/permissions?${search}`)
        .then((r) => r.data);
    },
    queryKey: ['knowledge', 'permissions', teamId, orgId],
  });
}
export function useKnowledgeDetail(id: string | null) {
  return useQuery({
    enabled: !!id,
    queryFn: () => api.get<{ data: KnowledgeItem }>(`${root}/${id}`).then((r) => r.data),
    queryKey: ['knowledge', 'detail', id],
  });
}
export function useKnowledgeCreate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      content: string;
      title: string;
      type: Exclude<KnowledgeType, 'LEARNING'>;
      teamId: string;
      repoId?: string;
    }) => api.post(root, body),
    onSuccess: () => invalidate(qc),
  });
}
export function useKnowledgeAction(
  action: 'approve' | 'publish' | 'reject' | 'supersede' | 'revise'
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      expectedVersion: number;
      visibility?: KnowledgeVisibility;
      selectedTeamIds?: string[];
      content?: string;
      title?: string;
    }) =>
      action === 'revise'
        ? api.put(`${root}/${id}`, body)
        : api.post(`${root}/${id}/${action}`, body),
    onSuccess: () => invalidate(qc),
  });
}
