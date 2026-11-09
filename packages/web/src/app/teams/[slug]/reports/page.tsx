'use client';

import { TeamLinkPanel } from '@/components/teams/space/TeamLinkPanel';
import { useTeamSpace } from '@/components/teams/space/TeamSpaceContext';

export default function TeamReportsPage() {
  const { team } = useTeamSpace();
  return (
    <TeamLinkPanel
      hint="Delivery, cost and quality reports, narrowed to this team."
      href="/admin/reports"
      icon="docs"
      linkLabel="Open the team's reports"
      slug={team.slug}
      title="Reports for this team"
    />
  );
}
