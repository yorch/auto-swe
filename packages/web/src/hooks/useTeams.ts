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

export function useTeam(id: string, options: { refetchOnMount?: boolean | 'always' } = {}) {
  return useQuery({
    enabled: !!id,
    queryFn: () =>
      api
        .get<{ data: TeamDetail & { monthlyBudgetUsdCents?: number | null } }>(
          `/api/v1/teams/${id}`
        )
        .then((r) => r.data),
    queryKey: ['team', id],
    refetchOnMount: options.refetchOnMount,
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
 * ADMIN does not belong to is absent, and a null `myRole` is never counted. Anyone but a platform
 * ADMIN needs it, because the team role alone decides; a platform ADMIN bypasses team checks and
 * does not load the list.
 */
function useTeamIdsWithRole(minRole: 'LEAD' | 'ADMIN'): ReadonlySet<string> | null {
  const user = useAuthStore((s) => s.user);
  const platformAdmin = hasRole(user?.role, 'ADMIN');
  // No lookup before the user is known: the request would go out unauthenticated.
  const teams = useTeams({ enabled: !!user && !platformAdmin, memberOnly: true });
  // Reduce to a string key first so the returned Set keeps its identity across
  // renders — callers put it in memo / callback deps.
  let key: string | null;
  if (platformAdmin) {
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
 * Whether the caller may start work that needs the lead of an owning team (an epic, a campaign): a
 * platform ADMIN, or anyone who leads at least one active team. False while the list loads, which
 * hides the control rather than flashing one that would be refused.
 */
export function useLeadsATeam(): boolean {
  const user = useAuthStore((s) => s.user);
  const led = useLedTeamIds();
  return hasRole(user?.role, 'ADMIN') || (led?.size ?? 0) > 0;
}

/**
 * The teams the caller may author team-owned resources for (a workflow template): the teams
 * they LEAD or ADMIN, read from `myRole`. A platform ADMIN may author for any team and for no
 * team at all (`global`), so they get every team the directory lists.
 */
export function useAuthoringTeams(): {
  teams: TeamSummary[];
  global: boolean;
  isLoading: boolean;
} {
  const user = useAuthStore((s) => s.user);
  const platformAdmin = hasRole(user?.role, 'ADMIN');
  const all = useTeams({ enabled: platformAdmin });
  const member = useTeams({ enabled: !!user && !platformAdmin, memberOnly: true });
  if (platformAdmin) {
    return { global: true, isLoading: all.isLoading, teams: all.data ?? [] };
  }
  return {
    global: false,
    isLoading: member.isLoading,
    teams: (member.data ?? []).filter((t) => hasRole(t.myRole, 'LEAD')),
  };
}

/**
 * What POST/PATCH /teams return: the team row itself, without the list-only extras (`myRole`,
 * `orgName`, `_count`).
 */
export type TeamRecord = Omit<TeamSummary, 'myRole' | 'orgName' | '_count'>;

export function useCreateTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      orgId,
      ...body
    }: {
      name: string;
      slug: string;
      description?: string;
      orgId?: string;
      adminUserId?: string;
    }) =>
      api.post<{ data: TeamRecord }>(
        orgId ? `/api/v1/platform/organizations/${orgId}/teams` : '/api/v1/teams',
        body
      ),
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

export function useInviteTeamMember(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; role: 'ADMIN' | 'LEAD' | 'ENGINEER' }) =>
      api.post<{ data: { id: string; email: string; isActive: boolean } }>(
        `/api/v1/teams/${teamId}/members/invite`,
        body
      ),
    onSuccess: () => {
      for (const queryKey of [
        ['teams'],
        ['team', teamId],
        ['team-overview', teamId],
        ['org-members'],
      ]) {
        void qc.invalidateQueries({ queryKey });
      }
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
        .get<{ data: { egressAllowlist: string[]; baselineAllowlist: string[] } }>(
          `/api/v1/teams/${teamId}/egress-allowlist`
        )
        .then((r) => r.data),
    queryKey: ['team-egress-allowlist', teamId],
  });
}

export function useUpdateTeamEgressAllowlist(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (egressAllowlist: string[]) =>
      api.put<{ data: { egressAllowlist: string[] }; warnings?: string[] }>(
        `/api/v1/teams/${teamId}/egress-allowlist`,
        {
          egressAllowlist,
        }
      ),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['team-egress-allowlist', teamId] }),
        qc.invalidateQueries({ queryKey: ['platform-readiness'] }),
      ]),
  });
}
