'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type RefObject, useMemo } from 'react';
import { useUsageScopes } from '@/hooks/useAdmin';
import { useApprovalsCount } from '@/hooks/useApprovals';
import { activeNavHref, visibleNavGroups } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

// SVG icon paths — each path is for viewBox="0 0 24 24" stroke icons
const ICONS: Record<string, string> = {
  admin: 'M12 9a3 3 0 100 6 3 3 0 000-6zM5 12l-2 1 2 3 2-1M19 12l2 1-2 3-2-1M12 5V3M12 21v-2',
  agents:
    'M12 3a3.5 3.5 0 013.5 3.5V8a3.5 3.5 0 01-7 0V6.5A3.5 3.5 0 0112 3zM5 21v-1a7 7 0 0114 0v1',
  analytics: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  canvas: 'M4 7h7M4 12h16M13 17h7',
  clock: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  connections: 'M9 15l6-6M10 6l1-1a4 4 0 016 6l-1 1M14 18l-1 1a4 4 0 01-6-6l1-1',
  dashboard: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  docs: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
  epics:
    'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M12 12v4M12 12l-2-2M12 12l2-2',
  inbox: 'M3 13l2-7h14l2 7M3 13v6h18v-6M3 13h5l1 2h6l1-2h5',
  key: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
  memory:
    'M12 3c4 0 8 1.3 8 3v12c0 1.7-4 3-8 3s-8-1.3-8-3V6c0-1.7 4-3 8-3zM4 6c0 1.7 4 3 8 3s8-1.3 8-3M4 12c0 1.7 4 3 8 3s8-1.3 8-3',
  repositories: 'M9 15l6-6M10 6l1-1a4 4 0 016 6l-1 1M14 18l-1 1a4 4 0 01-6-6l1-1',
  runs: 'M3 12h4l3 8 4-16 3 8h4',
  security: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z',
  settings:
    'M12 9a3 3 0 100 6 3 3 0 000-6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z',
  skills: 'M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.3L12 15.3 7.2 17.8l.9-5.3L4.2 8.7l5.4-.8z',
  teams:
    'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
  templates: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5',
  users:
    'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
  workflows: 'M4 7h7M4 12h16M13 17h7',
};

function NavIcon({ name }: { name: string }) {
  const d = ICONS[name] ?? ICONS.dashboard;
  return (
    <svg
      aria-hidden="true"
      className="shrink-0"
      fill="none"
      height={16}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
      viewBox="0 0 24 24"
      width={16}
    >
      <path d={d} />
    </svg>
  );
}

/** DOM id of the sidebar, referenced by the TopBar menu button's `aria-controls`. */
export const SIDEBAR_ID = 'app-sidebar';

interface SidebarProps {
  /** Drawer state below `md`. At `md` and up the sidebar is always shown. */
  open: boolean;
  onClose: () => void;
  /** First focus target when the drawer opens. */
  closeButtonRef?: RefObject<HTMLButtonElement | null>;
}

export function Sidebar({ open, onClose, closeButtonRef }: SidebarProps) {
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  const inboxCount = useApprovalsCount();

  const usageScopes = useUsageScopes();
  const hasUsageScope =
    usageScopes.data !== undefined &&
    (usageScopes.data.platform ||
      usageScopes.data.teams.length > 0 ||
      usageScopes.data.orgs.length > 0);
  const groups = useMemo(
    () => visibleNavGroups(user?.role, hasUsageScope),
    [user?.role, hasUsageScope]
  );
  // The most-specific matching nav item wins (e.g. /workflows/library over /workflows).
  const activeHref = useMemo(
    () =>
      activeNavHref(
        pathname,
        groups.flatMap((g) => g.items)
      ),
    [pathname, groups]
  );

  const avatarLetter = (user?.email ?? 'G')[0].toUpperCase();

  return (
    <aside
      aria-label="Main navigation"
      className={cn(
        'flex w-[234px] flex-col border-r border-ink-400 bg-ink-900',
        // Below md the sidebar is an off-canvas drawer; `invisible` when closed
        // takes its links out of the tab order and the accessibility tree.
        'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:shadow-2xl max-md:duration-200',
        // Visibility flips immediately on open (so focus can move in) and only
        // after the slide-out on close.
        open
          ? 'max-md:visible max-md:translate-x-0 max-md:transition-transform'
          : 'max-md:invisible max-md:-translate-x-full max-md:transition-[transform,visibility]'
      )}
      id={SIDEBAR_ID}
    >
      <div className="flex items-center justify-between">
        {/* Brand */}
        <Link className="flex items-center gap-3 px-[18px] py-[18px] no-underline" href="/">
          {/* Gradient logo mark */}
          <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] bg-gradient-to-br from-ember-400 to-violet-400 shadow-[0_6px_18px_-6px_color-mix(in_oklab,var(--color-ember-400)_70%,transparent)]">
            <svg
              aria-hidden="true"
              className="text-paper-50"
              fill="none"
              height={15}
              viewBox="0 0 24 24"
              width={15}
            >
              <path
                d="M4 7h7M4 12h16M13 17h7"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth={2.2}
              />
              <circle cx={17} cy={7} fill="currentColor" r={2.4} />
              <circle cx={7} cy={17} fill="currentColor" r={2.4} />
            </svg>
          </span>
          <span className="flex items-baseline gap-[3px]">
            <span className="text-[15px] font-bold tracking-[-0.02em] text-paper-100">auto</span>
            <span className="font-display text-[15px] font-semibold italic text-ember-400">
              ·swe
            </span>
          </span>
        </Link>
        <button
          aria-label="Close navigation"
          className="mr-3 rounded-md p-2 text-paper-400 hover:text-paper-100 md:hidden"
          onClick={onClose}
          ref={closeButtonRef}
          type="button"
        >
          <svg
            aria-hidden="true"
            fill="none"
            height={18}
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth={2}
            viewBox="0 0 24 24"
            width={18}
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      {/* Team context chip */}
      <div className="mx-[14px] mb-[10px] flex cursor-default items-center gap-[9px] rounded-[10px] border border-ink-400 bg-ink-700 px-[11px] py-[9px] text-[12.5px]">
        <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] bg-gradient-to-br from-dust-400 to-ember-400 text-[11px] font-bold text-paper-50">
          {avatarLetter}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold text-paper-200">
            {user?.email?.split('@')[0] ?? 'user'}
          </div>
          <div className="text-[10.5px] text-paper-500">
            {user?.role?.toLowerCase() ?? 'member'}
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto pb-4">
        {groups.map((group) => (
          <div key={group.label}>
            <div className="px-5 pb-[6px] pt-[14px] text-[10px] font-bold uppercase tracking-[0.12em] text-paper-600">
              {group.label}
            </div>
            {group.items.map((item) => {
              const active = activeHref === item.href;
              return (
                <Link
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-[11px] border-l-2 px-[18px] py-[8px] text-[13.5px] font-[550] no-underline transition-all',
                    active
                      ? 'border-ember-400 bg-ink-700 text-paper-100'
                      : 'border-transparent text-paper-500 hover:text-paper-200'
                  )}
                  href={item.href}
                  key={item.href}
                >
                  <NavIcon name={item.icon} />
                  <span className="flex-1">{item.label}</span>
                  {item.href === '/govern/approvals' && inboxCount > 0 && (
                    <span className="rounded-full bg-ember-400 px-[7px] py-px text-[10.5px] font-bold text-paper-50">
                      {inboxCount}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t border-ink-400 px-[18px] py-[14px]">
        <div className="flex items-center gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-ink-500 text-[11px] font-semibold text-paper-300">
            {avatarLetter}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs text-paper-400">{user?.email ?? 'guest'}</div>
          </div>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ember-400">
            {user?.role ?? '—'}
          </span>
        </div>
      </div>
    </aside>
  );
}
