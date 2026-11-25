'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { NeedsYouBadge } from '@/components/teams/NeedsYouBadge';
import { Icon } from '@/components/ui/Icon';
import { useTeamNav } from '@/hooks/useTeamNav';
import { useTeams } from '@/hooks/useTeams';
import { useUserPreferences } from '@/hooks/useUserPreferences';
import { teamRoleLabel } from '@/lib/roleLabels';
import { canPinMore, togglePinnedTeam } from '@/lib/teamPins';
import { type TeamTabId, teamHref, teamSlugFromPath, teamTabFromPath } from '@/lib/teamSpace';
import { cn, FOCUS_RING } from '@/lib/utils';

const MENU_ID = 'team-switcher-menu';

/**
 * Where the team switcher is the way around, not a filter: it lists the teams the caller is a
 * member of, with their role and what is waiting on them, and choosing one opens that team's
 * space (on the tab the caller is already on, when the team has it). "All my teams" is first.
 * `strip` is the full-width form for the phone's second row.
 */
export function TeamSwitcher({ variant = 'pill' }: { variant?: 'pill' | 'strip' }) {
  const pathname = usePathname();
  const { administered, entries } = useTeamNav();
  const { pinnedTeamSlugs, setPinnedTeamSlugs } = useUserPreferences();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointer = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    // Tabbing out of the menu closes it. A null target (a click on a non-focusable part of the
    // menu, or the window losing focus) is left alone: the pointer handler covers outside clicks.
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null;
      if (next && !root.current?.contains(next)) {
        setOpen(false);
      }
    };
    const rootEl = root.current;
    rootEl?.addEventListener('focusout', onFocusOut);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey, true);
    return () => {
      rootEl?.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const currentSlug = teamSlugFromPath(pathname);
  const known =
    entries.find((e) => e.team.slug === currentSlug)?.team ??
    administered.find((t) => t.slug === currentSlug);
  // A team the person is not on and the lists above do not carry (a platform admin's): the
  // visible-teams list names it, so the trigger never says "All my teams" inside another team.
  const lookup = useTeams({ enabled: !!currentSlug && !known });
  const current = known ?? lookup.data?.find((t) => t.slug === currentSlug);
  const currentName = current?.name ?? currentSlug ?? 'All my teams';
  // Keep the tab the caller is on; a path outside any team space opens the overview.
  const tab: TeamTabId = teamTabFromPath(pathname) ?? 'overview';
  const totalNeeds = entries.reduce((sum, e) => sum + e.needsYou, 0);

  const memberSlugs = entries.map((e) => e.team.slug);
  const pinnedSet = new Set(pinnedTeamSlugs);
  const pinsFull = !canPinMore(pinnedTeamSlugs, memberSlugs);

  const rowClass =
    'flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-paper-200 no-underline pointer-coarse:min-h-[44px] hover:bg-ink-700';

  return (
    <div className={cn('relative', variant === 'strip' ? 'min-w-0 flex-1' : 'shrink')} ref={root}>
      <button
        aria-controls={MENU_ID}
        aria-expanded={open}
        aria-label={`Switch team, current: ${currentName}`}
        className={cn(
          'flex items-center gap-2 text-sm text-paper-200 transition-colors pointer-coarse:min-h-[44px]',
          variant === 'strip'
            ? 'w-full rounded-md border border-ink-500 bg-ink-800 px-2.5 py-1.5'
            : 'rounded-full border border-ink-500 bg-ink-800 px-3 py-1 hover:border-ink-300',
          FOCUS_RING
        )}
        onClick={() => setOpen((o) => !o)}
        ref={trigger}
        type="button"
      >
        <span className="text-paper-500">team:</span>
        <span className="min-w-0 flex-1 truncate text-left">{currentName}</span>
        {!currentSlug && <NeedsYouBadge count={totalNeeds} />}
        <Icon
          className={cn('shrink-0 text-paper-500 transition-transform', open && 'rotate-180')}
          name="chevronDown"
          size={14}
        />
      </button>
      {open && (
        <ul
          aria-label="Teams"
          className="absolute left-0 z-30 mt-1 max-h-[70dvh] w-72 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-lg border border-ink-400 bg-ink-900 py-1 shadow-xl"
          id={MENU_ID}
        >
          <li>
            <Link
              aria-current={pathname === '/' ? 'page' : undefined}
              className={rowClass}
              href="/"
              onClick={() => setOpen(false)}
            >
              <Icon className="text-paper-500" name="dashboard" size={14} />
              <span className="flex-1">All my teams</span>
            </Link>
          </li>
          {entries.map(({ needsYou, team }) => {
            const isPinned = pinnedSet.has(team.slug);
            const blocked = !isPinned && pinsFull;
            return (
              <li className="flex items-stretch hover:bg-ink-700" key={team.id}>
                <Link
                  aria-current={team.slug === currentSlug ? 'page' : undefined}
                  className={cn(rowClass, 'min-w-0 flex-1 hover:bg-transparent')}
                  href={teamHref(team.slug, tab)}
                  onClick={() => setOpen(false)}
                >
                  <Icon className="text-paper-500" name="teams" size={14} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{team.name}</span>
                    <span className="block text-xs text-paper-500">
                      {teamRoleLabel(team.myRole)}
                    </span>
                  </span>
                  <NeedsYouBadge count={needsYou} />
                </Link>
                {/* A sibling of the link, not inside it: pinning must not navigate. */}
                <button
                  aria-disabled={blocked || undefined}
                  aria-label={
                    isPinned
                      ? `Unpin ${team.name} from the sidebar`
                      : `Pin ${team.name} to the sidebar`
                  }
                  aria-pressed={isPinned}
                  className={cn(
                    'flex w-9 shrink-0 items-center justify-center pointer-coarse:min-h-[44px] pointer-coarse:w-11',
                    isPinned ? 'text-accent-400' : 'text-paper-600 hover:text-paper-200',
                    blocked && 'cursor-not-allowed opacity-40',
                    FOCUS_RING
                  )}
                  onClick={() => {
                    if (!blocked) {
                      setPinnedTeamSlugs(togglePinnedTeam(pinnedTeamSlugs, team.slug, memberSlugs));
                    }
                  }}
                  title={blocked ? 'You can pin up to 20 teams. Unpin one first.' : undefined}
                  type="button"
                >
                  <Icon className={isPinned ? 'fill-current' : undefined} name="pin" size={14} />
                </button>
              </li>
            );
          })}
          {administered.length > 0 && (
            <li aria-labelledby="team-switcher-administered" role="presentation">
              <div
                className="px-3 pt-2 pb-1 text-2xs font-semibold uppercase tracking-[0.08em] text-paper-600"
                id="team-switcher-administered"
              >
                Administered
              </div>
              <ul aria-labelledby="team-switcher-administered">
                {administered.map((team) => (
                  <li key={team.id}>
                    <Link
                      aria-current={team.slug === currentSlug ? 'page' : undefined}
                      className={rowClass}
                      href={teamHref(team.slug, tab)}
                      onClick={() => setOpen(false)}
                    >
                      <Icon className="text-paper-500" name="teams" size={14} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{team.name}</span>
                        <span className="block text-xs text-paper-500">{team.orgName}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
