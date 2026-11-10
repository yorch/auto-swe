'use client';

import { TeamLinkPanel } from '@/components/teams/space/TeamLinkPanel';
import { useTeamSpace } from '@/components/teams/space/TeamSpaceContext';

export default function TeamKnowledgePage() {
  const { team } = useTeamSpace();
  return (
    <TeamLinkPanel
      hint="The team's knowledge items and what its agents carry from one run to the next."
      href="/knowledge"
      icon="layers"
      linkLabel="Open the team's knowledge"
      slug={team.slug}
      title="Knowledge for this team"
    />
  );
}
