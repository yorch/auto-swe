'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Permissions } from '@/lib/capabilities';
import { useAuthStore } from '@/stores/authStore';

/**
 * Every effective-permissions query lives under this key, so one invalidation (after a team or
 * role mutation) refreshes the person's whole answer and each narrowed `?teamId=` one. The signed-in
 * user's id is part of the key: a different person signing in never reads the previous one's answer.
 */
export const PERMISSIONS_KEY = ['me', 'permissions'] as const;

const STALE_MS = 60_000;

/**
 * What the signed-in person may do, as the server decided it (`GET /api/v1/me/permissions`): their
 * platform capabilities and, for each team and organization they belong to, the capabilities they
 * hold there and on what authority. Read it through `useCan`, not directly.
 */
export function useEffectivePermissions(options: { enabled?: boolean } = {}) {
  const sub = useAuthStore((s) => s.user?.sub ?? null);
  return useQuery({
    enabled: sub !== null && (options.enabled ?? true),
    queryFn: () => api.get<Permissions>('/api/v1/me/permissions'),
    queryKey: [...PERMISSIONS_KEY, sub],
    staleTime: STALE_MS,
  });
}

/**
 * The same answer narrowed to one team, which includes the capabilities held there only through
 * organization or platform authority. A team the person has no standing on answers 403, which is
 * "holds nothing", so it is not retried.
 */
export function teamPermissionsQuery(sub: string | null, teamId: string | null | undefined) {
  return {
    enabled: sub !== null && !!teamId,
    queryFn: () => api.get<Permissions>(`/api/v1/me/permissions?teamId=${teamId}`),
    queryKey: [...PERMISSIONS_KEY, sub, 'team', teamId ?? null],
    retry: false,
    staleTime: STALE_MS,
  } as const;
}

export function useTeamPermissions(teamId: string | null | undefined, enabled = true) {
  const sub = useAuthStore((s) => s.user?.sub ?? null);
  const query = teamPermissionsQuery(sub, teamId);
  return useQuery({ ...query, enabled: query.enabled && enabled });
}
