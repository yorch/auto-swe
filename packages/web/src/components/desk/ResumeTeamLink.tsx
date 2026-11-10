'use client';

import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { useTeams } from '@/hooks/useTeams';
import { useUserPreferences } from '@/hooks/useUserPreferences';
import { teamHref } from '@/lib/teamSpace';
import { cn, FOCUS_RING } from '@/lib/utils';

/**
 * A link back to the team space the user last visited. The stored slug is only a hint: it is
 * resolved through the teams the caller is a member of, so a stale or foreign slug renders
 * nothing, with no error. Renders nothing while loading, on error, or when unset.
 */
export function ResumeTeamLink() {
  const { lastTeamSlug, loaded } = useUserPreferences();
  const memberTeams = useTeams({ memberOnly: true });
  if (!loaded || !lastTeamSlug || !memberTeams.isSuccess) {
    return null;
  }
  const team = memberTeams.data.find((t) => t.slug === lastTeamSlug);
  if (!team) {
    return null;
  }
  return (
    <Link
      className={cn(
        'inline-flex items-center gap-1 rounded-sm text-sm text-paper-100 underline-offset-2 hover:underline focus-visible:underline',
        FOCUS_RING
      )}
      href={teamHref(team.slug)}
    >
      Continue in {team.name}
      <Icon name="arrowRight" size={13} />
    </Link>
  );
}
