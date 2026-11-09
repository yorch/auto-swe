'use client';

import type { MeSummaryTeam } from '@auto-swe/shared/types/api';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';

const ROLE_LABEL: Record<MeSummaryTeam['myRole'], string> = {
  ADMIN: 'Admin',
  ENGINEER: 'Engineer',
  LEAD: 'Lead',
};

function TeamCard({ team }: { team: MeSummaryTeam }) {
  return (
    <Card className="p-4 sm:p-4" data-testid="team-card">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-paper-100">{team.name}</h3>
          <p className="truncate text-xs text-paper-500">{team.orgName}</p>
        </div>
        <Badge tone="neutral" variant="outline">
          {ROLE_LABEL[team.myRole]}
        </Badge>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-paper-500">Needs you</dt>
          <dd className="tabular text-base font-semibold text-paper-100">{team.needsYou}</dd>
        </div>
        <div>
          <dt className="text-paper-500">Running</dt>
          <dd className="tabular text-base font-semibold text-paper-100">{team.running}</dd>
        </div>
        <div>
          <dt className="text-paper-500">Queued</dt>
          <dd className="tabular text-base font-semibold text-paper-100">{team.queued}</dd>
        </div>
      </dl>
    </Card>
  );
}

/**
 * The teams the user belongs to. A one-team user gets a single line instead of a card. The cards
 * are not links: a team's own page does not exist yet.
 */
export function MyTeams({ teams }: { teams: MeSummaryTeam[] }) {
  if (teams.length === 0) {
    return null;
  }
  if (teams.length === 1) {
    return (
      <p className="text-sm text-paper-400" data-testid="single-team">
        You are in <span className="font-medium text-paper-100">{teams[0]?.name}</span>
        {teams[0]?.orgName ? ` (${teams[0].orgName})` : ''}.
      </p>
    );
  }
  return (
    <section aria-labelledby="my-teams-title">
      <h2 className="mb-3 text-lg font-semibold tracking-tight text-paper-100" id="my-teams-title">
        My teams
      </h2>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {teams.map((team) => (
          <li key={team.teamId}>
            <TeamCard team={team} />
          </li>
        ))}
      </ul>
    </section>
  );
}
