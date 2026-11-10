import type { TeamRef } from '@auto-swe/shared/types/api';

/** Why a repository cannot be picked for new work; fixed wording, shown beside the option. */
export const VIEW_ONLY_REASON = 'Owner team set this repository to view only for your team';

/** Short form for a chip beside a repository the sharing team may read but not launch on. */
export const VIEW_ONLY_CHIP = 'View only';

interface Launchable {
  team?: TeamRef;
  shares?: Array<{ canLaunch?: boolean; team: TeamRef }>;
}

/**
 * Whether a repository is view only for the caller: they reach it only through teams it is shared
 * with, and every such share has `canLaunch` off. Owning the repository (being in its team), or
 * reaching it through any share that allows launching, is enough to launch. A platform ADMIN is
 * never held back. The server decides in the end; this only keeps the dashboard from offering
 * what it would refuse.
 *
 * `myTeamIds` is `null` while the caller's teams are loading, which answers false rather than
 * flashing a disabled option.
 */
export function isViewOnlyFor(
  repo: Launchable,
  myTeamIds: ReadonlySet<string> | null,
  platformAdmin: boolean
): boolean {
  if (platformAdmin || !myTeamIds) {
    return false;
  }
  if (repo.team && myTeamIds.has(repo.team.id)) {
    return false;
  }
  const reaching = (repo.shares ?? []).filter((s) => myTeamIds.has(s.team.id));
  return reaching.length > 0 && reaching.every((s) => s.canLaunch === false);
}
