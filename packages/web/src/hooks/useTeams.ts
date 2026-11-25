'use client';

import type { TeamDetail, TeamSummary } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ME_SUMMARY_KEY } from '@/hooks/useMeSummary';
import { api } from '@/lib/api';
import { holdsCapability, isPlatformAdminAnswer } from '@/lib/capabilities';
import type { TeamRoleValue } from '@/lib/roleLabels';
import { PERMISSIONS_KEY, useEffectivePermissions } from './useEffectivePermissions';

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
 * The teams the caller may author team-owned resources for (a workflow template): the teams on
 * which the server says they hold `team.templates.write`. A platform administrator may author for
 * any team and for no team at all (`global`), so they get every team the directory lists.
 */
export function useAuthoringTeams(): {
  teams: TeamSummary[];
  global: boolean;
  isLoading: boolean;
} {
  const { data: perms, isLoading: permsLoading } = useEffectivePermissions();
  const platformAdmin = isPlatformAdminAnswer(perms);
  const all = useTeams({ enabled: platformAdmin });
  const member = useTeams({ enabled: !!perms && !platformAdmin, memberOnly: true });
  if (platformAdmin) {
    return { global: true, isLoading: all.isLoading, teams: all.data ?? [] };
  }
  return {
    global: false,
    isLoading: permsLoading || member.isLoading,
    teams: (member.data ?? []).filter((t) =>
      holdsCapability(perms, 'team.templates.write', { teamId: t.id })
    ),
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['teams'] });
      qc.invalidateQueries({ queryKey: ['team-directory'] });
      qc.invalidateQueries({ queryKey: PERMISSIONS_KEY });
    },
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
    mutationFn: (body: { userId: string; role?: TeamRoleValue }) =>
      api.post(`/api/v1/teams/${teamId}/members`, body),
    onSuccess: () => {
      // A change of membership changes what the person's effective permissions say.
      qc.invalidateQueries({ queryKey: PERMISSIONS_KEY });
      qc.invalidateQueries({ queryKey: ['teams'] });
      qc.invalidateQueries({ queryKey: ['team', teamId] });
      qc.invalidateQueries({ queryKey: ['team-overview', teamId] });
      qc.invalidateQueries({ queryKey: ME_SUMMARY_KEY });
    },
  });
}

export function useInviteTeamMember(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; role: TeamRoleValue }) =>
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
        PERMISSIONS_KEY,
      ]) {
        void qc.invalidateQueries({ queryKey });
      }
    },
  });
}

export function useUpdateTeamMember(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: TeamRoleValue }) =>
      api.patch(`/api/v1/teams/${teamId}/members/${userId}`, { role }),
    onSuccess: () => {
      // A change of membership changes what the person's effective permissions say.
      qc.invalidateQueries({ queryKey: PERMISSIONS_KEY });
      qc.invalidateQueries({ queryKey: ['teams'] });
      qc.invalidateQueries({ queryKey: ['team', teamId] });
      qc.invalidateQueries({ queryKey: ['team-overview', teamId] });
      qc.invalidateQueries({ queryKey: ME_SUMMARY_KEY });
    },
  });
}

export function useRemoveTeamMember(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.delete(`/api/v1/teams/${teamId}/members/${userId}`),
    onSuccess: () => {
      // A change of membership changes what the person's effective permissions say.
      qc.invalidateQueries({ queryKey: PERMISSIONS_KEY });
      qc.invalidateQueries({ queryKey: ['teams'] });
      qc.invalidateQueries({ queryKey: ['team', teamId] });
      qc.invalidateQueries({ queryKey: ['team-overview', teamId] });
      qc.invalidateQueries({ queryKey: ME_SUMMARY_KEY });
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
