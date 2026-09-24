'use client';

import type { TeamDetail, TeamSummary } from '@auto-swe/shared/types/api';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '@/lib/api';
import { hasRole } from '@/lib/roles';
import { useAuthStore } from '@/stores/authStore';

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

/**
 * Ids of the active teams the caller leads (LEAD or ADMIN membership) — the
 * team-scoped write bar the gateway applies to templates and connections on
 * top of the platform role. `null` until known.
 *
 * The team list carries no per-caller role, so this reads each team's detail
 * (the same `['team', id]` cache the team page uses). Only a platform LEAD
 * needs it: an ENGINEER can write nothing and a platform ADMIN bypasses team
 * checks, so neither fires the fan-out.
 */
export function useLedTeamIds(): ReadonlySet<string> | null {
  const user = useAuthStore((s) => s.user);
  const needsLookup = hasRole(user?.role, 'LEAD') && !hasRole(user?.role, 'ADMIN');
  const teams = useQuery({
    enabled: needsLookup,
    queryFn: () => api.get<{ data: TeamSummary[] }>('/api/v1/teams').then((r) => r.data),
    queryKey: ['teams'],
  });
  const details = useQueries({
    queries: (needsLookup ? (teams.data ?? []) : []).map((t) => ({
      queryFn: () => api.get<{ data: TeamDetail }>(`/api/v1/teams/${t.id}`).then((r) => r.data),
      queryKey: ['team', t.id],
    })),
  });
  // Reduce to a string key first so the returned Set keeps its identity across
  // renders — callers put it in memo / callback deps.
  let key: string | null;
  if (!needsLookup) {
    key = '';
  } else if (!user || !teams.data || details.some((d) => d.isPending)) {
    key = null;
  } else {
    key = details
      .filter((d) =>
        hasRole(d.data?.memberships.find((m) => m.user?.id === user.sub)?.role, 'LEAD')
      )
      .map((d) => d.data?.id ?? '')
      .sort()
      .join(',');
  }
  return useMemo(() => (key === null ? null : new Set(key ? key.split(',') : [])), [key]);
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
    mutationFn: (body: {
      name?: string;
      description?: string;
      defaultPersonaPrompt?: string | null;
    }) => api.patch<{ data: TeamSummary }>(`/api/v1/teams/${id}`, body),
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
