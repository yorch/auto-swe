'use client';

import { TeamOverviewView } from '@/components/teams/space/TeamOverviewView';
import { TeamSetupChecklist } from '@/components/teams/space/TeamSetupChecklist';
import { useTeamSpace } from '@/components/teams/space/TeamSpaceContext';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useCan } from '@/hooks/useCan';
import { useTeamOverview } from '@/hooks/useTeamOverview';

export default function TeamOverviewPage() {
  const { canManageBudget, team } = useTeamSpace();
  const query = useTeamOverview(team.id);
  const canManageMembers = useCan('team.members.manage', { orgId: team.orgId, teamId: team.id });
  return (
    <div className="space-y-6">
      <TeamSetupChecklist team={team} />
      <QueryBoundary
        error={query.error}
        isError={query.isError}
        isFetching={query.isFetching}
        isLoading={query.isLoading}
        label="team overview"
        onRetry={() => void query.refetch()}
        shape="cards"
      >
        {query.data && (
          <TeamOverviewView
            canManageBudget={canManageBudget}
            canManageMembers={canManageMembers}
            overview={query.data}
            slug={team.slug}
          />
        )}
      </QueryBoundary>
    </div>
  );
}
