'use client';

import NotFound from '@/app/not-found';
import { TeamManagePanel } from '@/components/teams/space/TeamManagePanel';
import { useTeamSpace } from '@/components/teams/space/TeamSpaceContext';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useCanState } from '@/hooks/useCan';

export default function TeamManagePage() {
  const { canManageBudget, team } = useTeamSpace();
  const manage = useCanState('team.attention.read', { orgId: team.orgId, teamId: team.id });
  if (manage.pending || manage.error) {
    return (
      <QueryBoundary
        error={manage.error}
        isError={!!manage.error}
        isFetching={false}
        isLoading={manage.pending}
        label="team permissions"
        onRetry={manage.retry}
        shape="detail"
      />
    );
  }
  if (!manage.allowed) {
    return <NotFound />;
  }
  return <TeamManagePanel canManageBudget={canManageBudget} team={team} />;
}
