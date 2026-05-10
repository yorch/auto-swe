'use client';

import type {
  LessonListItem,
  RepositorySummary,
  TeamDetail,
  TeamSummary,
  UserSummary,
  WorkflowDetail,
  WorkflowSummary,
} from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useWorkflows() {
  return useQuery({
    queryFn: () => api.get<{ data: WorkflowSummary[] }>('/api/v1/workflows').then((r) => r.data),
    queryKey: ['workflows'],
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

export function useTeams() {
  return useQuery({
    queryFn: () => api.get<{ data: TeamSummary[] }>('/api/v1/teams').then((r) => r.data),
    queryKey: ['teams'],
  });
}

export function useTeam(id: string) {
  return useQuery({
    enabled: !!id,
    queryFn: () => api.get<{ data: TeamDetail }>(`/api/v1/teams/${id}`).then((r) => r.data),
    queryKey: ['team', id],
  });
}

export function useRepositories() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: RepositorySummary[] }>('/api/v1/repositories').then((r) => r.data),
    queryKey: ['repositories'],
  });
}

export function useUsers() {
  return useQuery({
    queryFn: () => api.get<{ data: UserSummary[] }>('/api/v1/users').then((r) => r.data),
    queryKey: ['users'],
  });
}

export function useLessons() {
  return useQuery({
    queryFn: () => api.get<{ data: LessonListItem[] }>('/api/v1/lessons').then((r) => r.data),
    queryKey: ['lessons'],
  });
}

export function useCreateWorkRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { externalTicketId: string; description: string; repoIds: string[] }) =>
      api.post('/api/v1/work-requests', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflows'] }),
  });
}
