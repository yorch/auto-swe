'use client';

import type { TeamDetail, TeamSummary } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

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

export function useCreateTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; slug: string; description?: string }) =>
      api.post<{ data: TeamSummary }>('/api/v1/teams', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teams'] }),
  });
}

export function useUpdateTeam(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; description?: string }) =>
      api.patch<{ data: TeamSummary }>(`/api/v1/teams/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['teams'] });
      qc.invalidateQueries({ queryKey: ['team', id] });
    },
  });
}

export function useAddTeamMember(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { userId: string; role?: 'ADMIN' | 'LEAD' | 'ENGINEER' }) =>
      api.post(`/api/v1/teams/${teamId}/members`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team', teamId] }),
  });
}

export function useUpdateTeamMember(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: 'ADMIN' | 'LEAD' | 'ENGINEER' }) =>
      api.patch(`/api/v1/teams/${teamId}/members/${userId}`, { role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team', teamId] }),
  });
}

export function useRemoveTeamMember(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.delete(`/api/v1/teams/${teamId}/members/${userId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team', teamId] }),
  });
}

export function useTeamShellAllowlist(teamId: string) {
  return useQuery({
    enabled: !!teamId,
    queryFn: () =>
      api
        .get<{ data: { shellImageAllowlist: string[] } }>(
          `/api/v1/teams/${teamId}/shell-image-allowlist`
        )
        .then((r) => r.data),
    queryKey: ['team-shell-allowlist', teamId],
  });
}

export function useUpdateTeamShellAllowlist(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shellImageAllowlist: string[]) =>
      api.put<{ data: { shellImageAllowlist: string[] } }>(
        `/api/v1/teams/${teamId}/shell-image-allowlist`,
        { shellImageAllowlist }
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team-shell-allowlist', teamId] }),
  });
}

export function useTeamEgressAllowlist(teamId: string) {
  return useQuery({
    enabled: !!teamId,
    queryFn: () =>
      api
        .get<{ data: { egressAllowlist: string[] } }>(`/api/v1/teams/${teamId}/egress-allowlist`)
        .then((r) => r.data),
    queryKey: ['team-egress-allowlist', teamId],
  });
}

export function useUpdateTeamEgressAllowlist(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (egressAllowlist: string[]) =>
      api.put<{ data: { egressAllowlist: string[] } }>(`/api/v1/teams/${teamId}/egress-allowlist`, {
        egressAllowlist,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team-egress-allowlist', teamId] }),
  });
}
