'use client';

import { useTeamSpace } from '@/components/teams/space/TeamSpaceContext';
import { TeamWorkView } from '@/components/teams/space/TeamWorkView';

export default function TeamWorkPage() {
  const { team } = useTeamSpace();
  return <TeamWorkView teamId={team.id} />;
}
