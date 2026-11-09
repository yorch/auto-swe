import { Badge } from '@/components/ui/Badge';

/**
 * The team a row of work belongs to, as a quiet label. A global list that mixes teams' work
 * names the owner on each row; it is not a filter (that is {@link TeamChip}).
 */
export function TeamLabel({ teams }: { teams: { id: string; name: string }[] }) {
  if (teams.length === 0) {
    return null;
  }
  return (
    <span className="inline-flex flex-wrap gap-1.5" data-testid="team-label">
      {teams.map((team) => (
        <Badge key={team.id} tone="neutral" variant="outline">
          {team.name}
        </Badge>
      ))}
    </span>
  );
}
