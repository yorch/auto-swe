'use client';

import type { TeamSummary } from '@auto-swe/shared/types/api';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import { useHasRole } from '@/hooks/useHasRole';
import { useTeams } from '@/hooks/useTeams';

export interface TeamParam {
  /** The raw `?team=` value; empty when absent. */
  slug: string;
  /** The member team it names; null when there is none, or the slug is unknown or foreign. */
  team: TeamSummary | null;
  /** `team.id`, for the list hooks' `teamId` option. */
  teamId: string | undefined;
  /**
   * True while a `?team=` slug is present and the team list has not answered yet. A list hook
   * waits (`enabled: !pending`) so it does not flash the all-teams rows before narrowing.
   */
  pending: boolean;
  /**
   * True when a `?team=` slug is present, nothing resolved it, and a team-list request failed. The
   * slug is then unresolved rather than unknown, so a page shows an error instead of the
   * all-teams rows.
   */
  isError: boolean;
  /** `pending || isError`: a list hook stays disabled (`enabled: !blocked`) in both cases. */
  blocked: boolean;
  /** Ask the team list again after an error. */
  retry: () => void;
  /** Drop the parameter (and any page offset, which counted the narrowed list). */
  clear: () => void;
}

/**
 * The team filter of a global page: `?team=<slug>`. The slug is resolved through the caller's
 * member teams only, so a slug naming a team they are not in (or none at all) is ignored without
 * an error and says nothing about whether that team exists. The URL is the whole state. Callers
 * render inside Suspense, as every `useSearchParams` reader does.
 */
export function useTeamParam(): TeamParam {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const slug = params.get('team') ?? '';
  const isPlatformAdmin = useHasRole('ADMIN');
  const members = useTeams({ enabled: !!slug, memberOnly: true });
  // A platform ADMIN may open a team space they are not in, so the slug also resolves through
  // the full list when the member lookup misses. Nobody else gets that fallback.
  const all = useTeams({ enabled: !!slug && isPlatformAdmin });
  const memberHit = slug ? members.data?.find((t) => t.slug === slug) : undefined;
  const team =
    memberHit ??
    (slug && isPlatformAdmin ? all.data?.find((t) => t.slug === slug) : undefined) ??
    null;
  const resolved = team !== null;
  const lookups = isPlatformAdmin ? [members, all] : [members];
  const pending = !!slug && !resolved && lookups.some((q) => q.isLoading);
  const isError = !!slug && !resolved && !pending && lookups.some((q) => q.isError);
  const retry = () => {
    for (const q of lookups) {
      if (q.isError) {
        void q.refetch();
      }
    }
  };
  const clear = useCallback(() => {
    const next = new URLSearchParams(params);
    next.delete('team');
    next.delete('offset');
    next.delete('page');
    router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false });
  }, [params, pathname, router]);
  return {
    blocked: pending || isError,
    clear,
    isError,
    pending,
    retry,
    slug,
    team,
    teamId: team?.id,
  };
}
