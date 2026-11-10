'use client';

import { TeamMembersPanel } from '@/components/teams/space/TeamMembersPanel';
import { useTeamSpace } from '@/components/teams/space/TeamSpaceContext';

export default function TeamMembersPage() {
  const { team } = useTeamSpace();
  return <TeamMembersPanel team={team} />;
}
