import type { TeamSecretSummary } from '@auto-swe/shared/types/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * A team's secrets: write-only values that workspace setup steps and app previews receive as
 * environment variables, but only in repositories the team grants them to. Only the name, last
 * four characters and the granted repository ids come back, never a value.
 */
export function useTeamSecrets(teamId: string) {
  return useQuery({
    enabled: Boolean(teamId),
    queryFn: () =>
      api.get<{ data: TeamSecretSummary[] }>(`/api/v1/teams/${teamId}/secrets`).then((r) => r.data),
    queryKey: ['team-secrets', teamId],
  });
}

/** Create or replace a team secret. The value is sent once and never read back. */
export function useSaveTeamSecret(teamId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, value }: { name: string; value: string }) =>
      api.put<{ data: TeamSecretSummary }>(
        `/api/v1/teams/${teamId}/secrets/${encodeURIComponent(name)}`,
        { value }
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['team-secrets', teamId] }),
        queryClient.invalidateQueries({ queryKey: ['repositories'] }),
      ]),
  });
}

export function useDeleteTeamSecret(teamId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.delete(`/api/v1/teams/${teamId}/secrets/${encodeURIComponent(name)}`),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['team-secrets', teamId] }),
        queryClient.invalidateQueries({ queryKey: ['repositories'] }),
      ]),
  });
}

/** Replace the set of repositories a team secret is granted to (owned repositories only). */
export function useSetTeamSecretGrants(teamId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ connectionIds, name }: { name: string; connectionIds: string[] }) =>
      api.put<{ data: TeamSecretSummary }>(
        `/api/v1/teams/${teamId}/secrets/${encodeURIComponent(name)}/grants`,
        { connectionIds }
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['team-secrets', teamId] }),
        queryClient.invalidateQueries({ queryKey: ['repositories'] }),
      ]),
  });
}
