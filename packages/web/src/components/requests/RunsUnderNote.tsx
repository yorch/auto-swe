import type { TeamRef } from '@auto-swe/shared/types/api';

/**
 * Says which team a piece of work runs under. Work always runs under the team that owns the
 * repository, even when the person came in through a team the repository is only shared with.
 */
export function RunsUnderNote({
  owner,
  scope,
}: {
  owner: TeamRef | undefined;
  scope: { id: string; name: string } | null;
}) {
  if (!owner) {
    return null;
  }
  const shared = scope && scope.id !== owner.id;
  return (
    <p className="text-xs text-paper-500" data-testid="runs-under">
      This work runs under <span className="font-medium text-paper-300">{owner.name}</span>
      {shared ? `, the team that owns the repository (shared with ${scope.name})` : ''}.
    </p>
  );
}
