import { Badge } from '@/components/ui/Badge';

/**
 * The team a row of work belongs to, as a quiet label. A global list that mixes teams' work
 * names the owner on each row; it is not a filter (that is {@link TeamChip}).
 *
 * Inside a team's space, pass `viewerTeamId`: the viewer's own team is then omitted (it is the
 * page) and any other owner reads "owned by <team>", the work being shared into this team.
 */
export function TeamLabel({
  teams,
  viewerTeamId,
}: {
  teams: { id: string; name: string }[];
  viewerTeamId?: string;
}) {
  const shown = viewerTeamId ? teams.filter((team) => team.id !== viewerTeamId) : teams;
  if (shown.length === 0) {
    return null;
  }
  return (
    <span className="inline-flex flex-wrap gap-1.5" data-testid="team-label">
      {shown.map((team) =>
        viewerTeamId ? (
          <Badge key={team.id} tone="info" variant="outline">
            <span data-testid="owner-chip">owned by {team.name}</span>
          </Badge>
        ) : (
          <Badge key={team.id} tone="neutral" variant="outline">
            {team.name}
          </Badge>
        )
      )}
    </span>
  );
}
