'use client';

import type { TeamDetail, TeamSummary } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '@/lib/api';
import { hasRole } from '@/lib/roles';
import { useAuthStore } from '@/stores/authStore';

/**
 * The teams the caller can see, each with their own role in it (`myRole`). `memberOnly` asks for
 * just the teams they belong to, which a platform ADMIN otherwise does not get.
 */
export function useTeams(options: { enabled?: boolean; memberOnly?: boolean } = {}) {
  const { enabled = true, memberOnly = false } = options;
  return useQuery({
    enabled,
    queryFn: () =>
      api
        .get<{ data: TeamSummary[] }>(memberOnly ? '/api/v1/teams?member=true' : '/api/v1/teams')
        .then((r) => r.data),
    queryKey: memberOnly ? ['teams', 'member'] : ['teams'],
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
 */
export function useLedTeamIds(): ReadonlySet<string> | null {
  return useTeamIdsWithRole('LEAD');
}

/**
 * Ids of the active teams the caller is an ADMIN of — the gateway's
 * `workflow:write:shell` bar for code an author writes that runs in a
 * workspace: shell steps, gate commands. `null` until known.
 */
export function useAdminTeamIds(): ReadonlySet<string> | null {
  return useTeamIdsWithRole('ADMIN');
}

/**
 * Ids of the teams where the caller's own membership is at least `minRole`, read from the
 * `myRole` the team list carries. The list is requested `member=true`, so a team a platform
 * ADMIN does not belong to is absent, and a null `myRole` is never counted. Only a platform LEAD
 * needs it: an ENGINEER can write nothing and a platform ADMIN bypasses team checks, so neither
 * loads the list.
 */
function useTeamIdsWithRole(minRole: 'LEAD' | 'ADMIN'): ReadonlySet<string> | null {
  const user = useAuthStore((s) => s.user);
  const needsLookup = hasRole(user?.role, 'LEAD') && !hasRole(user?.role, 'ADMIN');
  const teams = useTeams({ enabled: needsLookup, memberOnly: true });
  // Reduce to a string key first so the returned Set keeps its identity across
  // renders — callers put it in memo / callback deps.
  let key: string | null;
  if (!needsLookup) {
    key = '';
  } else if (!user || !teams.data) {
    key = null;
  } else {
    key = teams.data
      .filter((t) => hasRole(t.myRole, minRole))
      .map((t) => t.id)
      .sort()
      .join(',');
  }
  return useMemo(() => (key === null ? null : new Set(key ? key.split(',') : [])), [key]);
}

/**
 * What POST/PATCH /teams return: the team row itself, without the list-only extras (`myRole`,
 * `orgName`, `_count`).
 */
export type TeamRecord = Omit<TeamSummary, 'myRole' | 'orgName' | '_count'>;

export function useCreateTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; slug: string; description?: string }) =>
      api.post<{ data: TeamRecord }>('/api/v1/teams', body),
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
    }) => api.patch<{ data: TeamRecord }>(`/api/v1/teams/${id}`, body),
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
    onSuccess: () => {
      // ['teams'] prefix-matches ['teams', 'member'], which the led/admin sets read `myRole` from.
      qc.invalidateQueries({ queryKey: ['teams'] });
      qc.invalidateQueries({ queryKey: ['team', teamId] });
    },
  });
}

export function useUpdateTeamMember(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: 'ADMIN' | 'LEAD' | 'ENGINEER' }) =>
      api.patch(`/api/v1/teams/${teamId}/members/${userId}`, { role }),
    onSuccess: () => {
      // ['teams'] prefix-matches ['teams', 'member'], which the led/admin sets read `myRole` from.
      qc.invalidateQueries({ queryKey: ['teams'] });
      qc.invalidateQueries({ queryKey: ['team', teamId] });
    },
  });
}

export function useRemoveTeamMember(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.delete(`/api/v1/teams/${teamId}/members/${userId}`),
    onSuccess: () => {
      // ['teams'] prefix-matches ['teams', 'member'], which the led/admin sets read `myRole` from.
      qc.invalidateQueries({ queryKey: ['teams'] });
      qc.invalidateQueries({ queryKey: ['team', teamId] });
    },
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
