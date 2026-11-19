'use client';

import { useMemo } from 'react';
import { useCanOnTeams } from './useCan';
import { useTeams } from './useTeams';

/** The teams the caller may create a repository connection in (`team.repos.create` there). */
export function useRepositoryTeams() {
  const { data: teams } = useTeams();
  const canCreate = useCanOnTeams(
    'team.repos.create',
    useMemo(() => (teams ?? []).map((t) => ({ id: t.id, orgId: t.orgId })), [teams])
  );
  // Keyed by the ids, so the list keeps its identity while the answer does not change.
  const allowed = (teams ?? [])
    .filter((team) => canCreate(team.id))
    .map((t) => t.id)
    .join(',');
  return useMemo(() => {
    const ids = new Set(allowed ? allowed.split(',') : []);
    return (teams ?? []).filter((team) => ids.has(team.id));
  }, [teams, allowed]);
}
