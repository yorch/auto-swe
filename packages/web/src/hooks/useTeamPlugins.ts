'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * The plugins a platform admin approved, as one team sees them (`/api/v1/teams/:teamId/plugins`):
 * whether the team has enabled each. Any team member may read; a team ADMIN enables and disables.
 * Names and descriptions came from a repository, so render them through `visibleText`.
 */
export interface TeamPlugin {
  name: string;
  description: string;
  latestVersion: number;
  hooksEnabled: boolean;
  enabled: boolean;
  enabledAt: string | null;
}

/** An agent version on the team that still names a plugin the team no longer enables. */
export interface StrandedAgent {
  key: string;
  version: number;
}

const key = (teamId: string) => ['team-plugins', teamId];
const url = (teamId: string, name: string) =>
  `/api/v1/teams/${teamId}/plugins/${encodeURIComponent(name)}`;

export function useTeamPlugins(teamId: string, enabled = true) {
  return useQuery({
    enabled: enabled && Boolean(teamId),
    queryFn: () =>
      api.get<{ data: TeamPlugin[] }>(`/api/v1/teams/${teamId}/plugins`).then((r) => r.data),
    queryKey: key(teamId),
  });
}

function useInvalidate(teamId: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: key(teamId) }),
      // Enablement decides which plugins an override may bind, and which agents are stranded.
      qc.invalidateQueries({ queryKey: ['harness-profiles'] }),
    ]);
}

export function useEnableTeamPlugin(teamId: string) {
  const invalidate = useInvalidate(teamId);
  return useMutation({
    mutationFn: (name: string) =>
      api.put<{ data: { name: string; enabled: true; enabledAt: string } }>(url(teamId, name), {}),
    onSuccess: invalidate,
  });
}

/** Resolves with the team's agents that now name a plugin the team does not enable. */
export function useDisableTeamPlugin(teamId: string) {
  const invalidate = useInvalidate(teamId);
  return useMutation({
    mutationFn: (name: string) =>
      api
        .delete<{ data: { name: string; enabled: false; strandedAgents: StrandedAgent[] } }>(
          url(teamId, name)
        )
        .then((r) => r.data),
    onSuccess: invalidate,
  });
}
