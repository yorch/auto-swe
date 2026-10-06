'use client';

import { useMemo } from 'react';
import { useUsageScopes } from '@/hooks/useAdmin';
import { type NavGroup, visibleNavGroups } from '@/lib/navigation';
import { useAuthStore } from '@/stores/authStore';

/** The nav groups the signed-in user may open — the sidebar and the command palette share it. */
export function useVisibleNavGroups(): NavGroup[] {
  const user = useAuthStore((s) => s.user);
  const usageScopes = useUsageScopes();
  const hasUsageScope =
    usageScopes.data !== undefined &&
    (usageScopes.data.platform ||
      usageScopes.data.teams.length > 0 ||
      usageScopes.data.orgs.length > 0);
  return useMemo(() => visibleNavGroups(user?.role, hasUsageScope), [user?.role, hasUsageScope]);
}
