'use client';

import { Suspense } from 'react';
import NotFound from '@/app/not-found';
import { TeamSettingsPanel } from '@/components/teams/space/TeamSettingsPanel';
import { useTeamSpace } from '@/components/teams/space/TeamSpaceContext';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useCanState } from '@/hooks/useCan';

export default function TeamSettingsPage() {
  const { canSeeSettings, team } = useTeamSpace();
  // The layout's flag is false until the per-team answer lands; ask here too so a direct link
  // reads "loading" or the failure, never a not-found that the answer then contradicts.
  const settings = useCanState('team.settings.manage', { orgId: team.orgId, teamId: team.id });
  if (settings.pending || settings.error) {
    return (
      <QueryBoundary
        error={settings.error}
        isError={!!settings.error}
        isFetching={false}
        isLoading={settings.pending}
        label="team permissions"
        onRetry={settings.retry}
        shape="detail"
      />
    );
  }
  if (!canSeeSettings && !settings.allowed) {
    return <NotFound />;
  }
  return (
    <Suspense>
      <TeamSettingsPanel team={team} />
    </Suspense>
  );
}
