'use client';

import { Suspense } from 'react';
import NotFound from '@/app/not-found';
import { TeamSettingsPanel } from '@/components/teams/space/TeamSettingsPanel';
import { useTeamSpace } from '@/components/teams/space/TeamSpaceContext';

export default function TeamSettingsPage() {
  const { canSeeSettings, team } = useTeamSpace();
  if (!canSeeSettings) {
    return <NotFound />;
  }
  return (
    <Suspense>
      <TeamSettingsPanel team={team} />
    </Suspense>
  );
}
