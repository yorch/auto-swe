'use client';

import NotFound from '@/app/not-found';
import { TeamManagePanel } from '@/components/teams/space/TeamManagePanel';
import { useTeamSpace } from '@/components/teams/space/TeamSpaceContext';
import { useCan } from '@/hooks/useCan';

export default function TeamManagePage() {
  const { canManageBudget, team } = useTeamSpace();
  const canSeeManage = useCan('team.attention.read', { orgId: team.orgId, teamId: team.id });
  if (!canSeeManage) {
    return <NotFound />;
  }
  return <TeamManagePanel canManageBudget={canManageBudget} team={team} />;
}
