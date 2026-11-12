'use client';

import { useMemo } from 'react';
import { hasRole } from '@/lib/roles';
import { useAuthStore } from '@/stores/authStore';
import { useUserOrgs } from './useAdmin';
import { useTeams } from './useTeams';

/** Active teams whose connections the caller may manage. */
export function useRepositoryTeams() {
  const role = useAuthStore((s) => s.user?.role);
  const { data: teams } = useTeams();
  const { data: orgs } = useUserOrgs({ enabled: role !== 'ADMIN' });
  return useMemo(
    () =>
      (teams ?? []).filter(
        (team) =>
          role === 'ADMIN' ||
          hasRole(team.myRole, 'LEAD') ||
          orgs?.some((org) => org.id === team.orgId && org.role === 'ORG_ADMIN')
      ),
    [teams, orgs, role]
  );
}
