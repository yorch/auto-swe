'use client';

import { useMemo } from 'react';
import { useUsageScopes } from '@/hooks/useAdmin';
import { useEffectivePermissions } from '@/hooks/useEffectivePermissions';
import { type NavGroup, visibleNavGroups } from '@/lib/navigation';

/** The nav groups the signed-in user may open — the sidebar and the command palette share it. */
export function useVisibleNavGroups(): NavGroup[] {
  const { data: perms } = useEffectivePermissions();
  const usageScopes = useUsageScopes();
  const hasUsageScope =
    usageScopes.data !== undefined &&
    (usageScopes.data.platform ||
      usageScopes.data.teams.length > 0 ||
      usageScopes.data.orgs.length > 0);
  return useMemo(() => visibleNavGroups(perms, hasUsageScope), [perms, hasUsageScope]);
}
