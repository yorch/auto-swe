import { MAX_PINNED_TEAM_SLUGS } from '@auto-swe/shared/types/api';

/**
 * The pinned team slugs a toggle leaves behind, for the `pinnedTeamSlugs` preference: only slugs of
 * teams the caller is a member of, de-duplicated, in pin order (a new pin goes last), at most
 * `MAX_PINNED_TEAM_SLUGS`. Slugs of teams the caller has left are dropped on any change, so the
 * stored list does not keep growing with names that resolve to nothing. Unpinning the last pin
 * returns `[]`, which the sidebar reads as "no pins" and answers with its default list.
 *
 * Returns the current list unchanged (same reference) when a pin would pass the limit, so the
 * caller can tell nothing happened.
 */
export function togglePinnedTeam(
  pinned: readonly string[],
  slug: string,
  memberSlugs: readonly string[]
): string[] {
  const members = new Set(memberSlugs);
  const current = [...new Set(pinned)].filter((s) => members.has(s));
  if (current.includes(slug)) {
    return current.filter((s) => s !== slug);
  }
  if (!members.has(slug)) {
    return current;
  }
  if (current.length >= MAX_PINNED_TEAM_SLUGS) {
    return pinned as string[];
  }
  return [...current, slug];
}

/** Whether another team can be pinned. */
export function canPinMore(pinned: readonly string[], memberSlugs: readonly string[]): boolean {
  const members = new Set(memberSlugs);
  return new Set(pinned.filter((s) => members.has(s))).size < MAX_PINNED_TEAM_SLUGS;
}
