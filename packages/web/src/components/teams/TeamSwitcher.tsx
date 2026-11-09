'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { NeedsYouBadge } from '@/components/teams/NeedsYouBadge';
import { Icon } from '@/components/ui/Icon';
import { useTeamNav } from '@/hooks/useTeamNav';
import {
  TEAM_ROLE_LABEL,
  type TeamTabId,
  teamHref,
  teamSlugFromPath,
  teamTabFromPath,
} from '@/lib/teamSpace';
import { cn, FOCUS_RING } from '@/lib/utils';

const MENU_ID = 'team-switcher-menu';

/**
 * Where the team switcher is the way around, not a filter: it lists the teams the caller is a
 * member of, with their role and what is waiting on them, and choosing one opens that team's
 * space (on the tab the caller is already on, when the team has it). "My desk" is first.
 * `strip` is the full-width form for the phone's second row.
 */
export function TeamSwitcher({ variant = 'pill' }: { variant?: 'pill' | 'strip' }) {
  const pathname = usePathname();
  const { entries } = useTeamNav();
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
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const currentSlug = teamSlugFromPath(pathname);
  const current = entries.find((e) => e.team.slug === currentSlug);
  // Keep the tab the caller is on; a path outside any team space opens the overview.
  const tab: TeamTabId = teamTabFromPath(pathname) ?? 'overview';
  const totalNeeds = entries.reduce((sum, e) => sum + e.needsYou, 0);

  const rowClass =
    'flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-paper-200 no-underline pointer-coarse:min-h-[44px] hover:bg-ink-700';

  return (
    <div className={cn('relative', variant === 'strip' ? 'min-w-0 flex-1' : 'shrink')} ref={root}>
      <button
        aria-controls={MENU_ID}
        aria-expanded={open}
        aria-label="Switch team"
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
        <span className="min-w-0 flex-1 truncate text-left">{current?.team.name ?? 'My desk'}</span>
        {!current && <NeedsYouBadge count={totalNeeds} />}
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
              <span className="flex-1">My desk</span>
            </Link>
          </li>
          {entries.map(({ needsYou, team }) => (
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
                  <span className="block text-xs text-paper-500">
                    {team.myRole ? TEAM_ROLE_LABEL[team.myRole] : ''}
                  </span>
                </span>
                <NeedsYouBadge count={needsYou} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
