'use client';

import { TeamLinkPanel } from '@/components/teams/space/TeamLinkPanel';
import { useTeamSpace } from '@/components/teams/space/TeamSpaceContext';

export default function TeamAutomationsPage() {
  const { team } = useTeamSpace();
  return (
    <TeamLinkPanel
      hint="Event automations, schedules and webhooks that start runs on this team's repositories."
      href="/admin/automations"
      icon="clock"
      linkLabel="Open the team's automations"
      slug={team.slug}
      title="Automations for this team"
    />
  );
}
