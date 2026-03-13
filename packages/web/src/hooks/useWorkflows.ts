'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  WorkflowSummary,
  WorkflowDetail,
  TeamSummary,
  TeamDetail,
  RepositorySummary,
  UserSummary,
  LessonSummary,
} from '@auto-swe/shared/types/api';

export function useWorkflows() {
  return useQuery({
    queryKey: ['workflows'],
    queryFn: () => api.get<{ data: WorkflowSummary[] }>('/api/v1/workflows').then((r) => r.data),
    refetchInterval: 10_000,
  });
}

export function useWorkflow(id: string) {
  return useQuery({
    queryKey: ['workflow', id],
    queryFn: () => api.get<{ data: WorkflowDetail }>(`/api/v1/workflows/${id}`).then((r) => r.data),
    refetchInterval: 5_000,
    enabled: !!id,
  });
}

export function useTeams() {
  return useQuery({
    queryKey: ['teams'],
    queryFn: () => api.get<{ data: TeamSummary[] }>('/api/v1/teams').then((r) => r.data),
  });
}

export function useTeam(id: string) {
  return useQuery({
    queryKey: ['team', id],
    queryFn: () => api.get<{ data: TeamDetail }>(`/api/v1/teams/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useRepositories() {
  return useQuery({
    queryKey: ['repositories'],
    queryFn: () => api.get<{ data: RepositorySummary[] }>('/api/v1/repositories').then((r) => r.data),
  });
}

export function useUsers() {
  return useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<{ data: UserSummary[] }>('/api/v1/users').then((r) => r.data),
  });
}

export function useLessons() {
  return useQuery({
    queryKey: ['lessons'],
    queryFn: () => api.get<{ data: LessonSummary[] }>('/api/v1/lessons').then((r) => r.data),
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
