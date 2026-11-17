'use client';

import NotFound from '@/app/not-found';
import { TeamManagePanel } from '@/components/teams/space/TeamManagePanel';
import { useTeamSpace } from '@/components/teams/space/TeamSpaceContext';
import { canSeeTeamManage } from '@/lib/teamSpace';
import { useAuthStore } from '@/stores/authStore';

export default function TeamManagePage() {
  const { canManageBudget, team } = useTeamSpace();
  const platformRole = useAuthStore((s) => s.user?.role);
  if (!canSeeTeamManage(platformRole, team.myRole)) {
    return <NotFound />;
  }
  return <TeamManagePanel canManageBudget={canManageBudget} team={team} />;
}
