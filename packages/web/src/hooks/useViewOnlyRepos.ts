'use client';

import { useMemo } from 'react';
import { usePlatformAdmin } from '@/hooks/useCan';
import { useTeams } from '@/hooks/useTeams';
import { isViewOnlyFor } from '@/lib/repoLaunch';

type Launchable = Parameters<typeof isViewOnlyFor>[0];

/**
 * Answers "is this repository view only for me" for launch pickers, from the teams the caller
 * belongs to. Nothing is view only while the teams load.
 */
export function useIsViewOnly(): (repo: Launchable) => boolean {
  const platformAdmin = usePlatformAdmin();
  const teams = useTeams({ enabled: !platformAdmin, memberOnly: true });
  const key = teams.data
    ? teams.data
        .map((t) => t.id)
        .sort()
        .join(',')
    : null;
  const myTeamIds = useMemo(
    () => (key === null ? null : new Set(key ? key.split(',') : [])),
    [key]
  );
  return (repo) => isViewOnlyFor(repo, myTeamIds, platformAdmin);
}
