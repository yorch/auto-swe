'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { useUsageScopes } from '@/hooks/useAdmin';
import { useApprovalsCount } from '@/hooks/useApprovals';
import {
  activeNavHref,
  isStartWorkPath,
  type NavItem,
  navSections,
  visibleNavGroups,
} from '@/lib/navigation';
import { cn, FOCUS_RING } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

// SVG icon paths — each path is for viewBox="0 0 24 24" stroke icons
const ICONS: Record<string, string> = {
  admin: 'M12 9a3 3 0 100 6 3 3 0 000-6zM5 12l-2 1 2 3 2-1M19 12l2 1-2 3-2-1M12 5V3M12 21v-2',
  agents:
    'M12 3a3.5 3.5 0 013.5 3.5V8a3.5 3.5 0 01-7 0V6.5A3.5 3.5 0 0112 3zM5 21v-1a7 7 0 0114 0v1',
  alert:
    'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  analytics: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  building:
    'M4 21V4a1 1 0 011-1h9a1 1 0 011 1v17M15 9h4a1 1 0 011 1v11M3 21h18M8 7h3M8 11h3M8 15h3',
  canvas: 'M4 7h7M4 12h16M13 17h7',
  chat: 'M21 12a8 8 0 01-11.7 7.1L4 20l1-4.6A8 8 0 1121 12z',
  clock: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  coin: 'M12 3a9 9 0 100 18 9 9 0 000-18zM14.8 9.2c-.5-.8-1.5-1.2-2.8-1.2-1.5 0-2.6.7-2.6 1.8 0 2.5 5.4 1.2 5.4 3.9 0 1.2-1.2 2-2.8 2-1.3 0-2.4-.5-3-1.4M12 6.5V8M12 16v1.5',
  connections: 'M9 15l6-6M10 6l1-1a4 4 0 016 6l-1 1M14 18l-1 1a4 4 0 01-6-6l1-1',
  dashboard: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  docs: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
  epics:
    'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M12 12v4M12 12l-2-2M12 12l2-2',
  flask: 'M9 3h6M10 3v6L4.5 19a1.5 1.5 0 001.3 2.2h12.4a1.5 1.5 0 001.3-2.2L14 9V3M7.5 15h9',
  gavel: 'M14 13l-8.5 8.5a2.1 2.1 0 01-3-3L11 10M16 16l6-6M8 8l6-6M9 7l8 8M21 11l-8-8',
  github:
    'M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 00-1.3-3.2 4.2 4.2 0 00-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 00-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 00-.1 3.2A4.6 4.6 0 004 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21',
  inbox: 'M3 13l2-7h14l2 7M3 13v6h18v-6M3 13h5l1 2h6l1-2h5',
  key: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
  layers: 'M12 2l10 5-10 5L2 7l10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  lock: 'M6 11h12a1 1 0 011 1v8a1 1 0 01-1 1H6a1 1 0 01-1-1v-8a1 1 0 011-1zM8 11V7a4 4 0 118 0v4',
  memory:
    'M12 3c4 0 8 1.3 8 3v12c0 1.7-4 3-8 3s-8-1.3-8-3V6c0-1.7 4-3 8-3zM4 6c0 1.7 4 3 8 3s8-1.3 8-3M4 12c0 1.7 4 3 8 3s8-1.3 8-3',
  monitor: 'M3 5h18a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V6a1 1 0 011-1zM8 21h8M12 17v4',
  package: 'M21 8l-9-5-9 5v8l9 5 9-5V8zM3.3 7.5L12 12.5l8.7-5M12 22V12.5',
  plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 01-12 0V8zM12 18v4',
  pullRequest:
    'M6 3a2 2 0 100 4 2 2 0 000-4zM6 17a2 2 0 100 4 2 2 0 000-4zM18 17a2 2 0 100 4 2 2 0 000-4zM6 7v10M18 17V9a2 2 0 00-2-2h-3m0 0l2-2m-2 2l2 2',
  puzzle:
    'M19.4 7.9c0 .3.1.6.3.9l1.6 1.6a2.4 2.4 0 010 3.4l-1.6 1.6a1 1 0 01-.8.3c-.5-.1-.8-.5-1-.9a2.5 2.5 0 10-3.2 3.2c.4.2.9.5.9 1a1 1 0 01-.3.8l-1.6 1.6a2.4 2.4 0 01-3.4 0l-1.6-1.6a1 1 0 00-.9-.3c-.5.1-.8.5-1 1a2.5 2.5 0 11-3.2-3.3c.5-.2.9-.5 1-1a1 1 0 00-.3-.9l-1.6-1.6a2.4 2.4 0 010-3.4l1.5-1.5c.3-.3.6-.4.9-.3.5.1.9.5 1.1 1a2.5 2.5 0 103.3-3.3c-.5-.2-.9-.6-1-1.1 0-.3.1-.7.3-.9l1.5-1.5a2.4 2.4 0 013.4 0l1.6 1.6c.2.2.6.3.9.3.5-.1.8-.5 1-1a2.5 2.5 0 113.2 3.2c-.5.2-.9.5-1 1z',
  repositories: 'M9 15l6-6M10 6l1-1a4 4 0 016 6l-1 1M14 18l-1 1a4 4 0 01-6-6l1-1',
  runs: 'M3 12h4l3 8 4-16 3 8h4',
  scan: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5M8 11h6M11 8v6',
  security: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z',
  settings:
    'M12 9a3 3 0 100 6 3 3 0 000-6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z',
  skills: 'M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.3L12 15.3 7.2 17.8l.9-5.3L4.2 8.7l5.4-.8z',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  target:
    'M12 3a9 9 0 100 18 9 9 0 000-18zM12 8a4 4 0 100 8 4 4 0 000-8zM12 11.5a.5.5 0 100 1 .5.5 0 000-1z',
  teams:
    'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
  templates: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5',
  ticket:
    'M3 9V7a2 2 0 012-2h14a2 2 0 012 2v2a2 2 0 000 4v2a2 2 0 01-2 2H5a2 2 0 01-2-2v-2a2 2 0 000-4zM14 5v14',
  users: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z',
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

const SECTIONS_KEY = 'auto-swe.nav.sections';

/** Which collapsible nav sections the user has closed or reopened (all start open), remembered per user in this browser. */
function useOpenSections(userKey: string) {
  const key = `${SECTIONS_KEY}.${userKey}`;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      setOpen(raw ? (JSON.parse(raw) as Record<string, boolean>) : {});
    } catch {
      setOpen({});
    }
  }, [key]);
  const toggle = (label: string, current: boolean) => {
    setOpen((prev) => {
      const next = { ...prev, [label]: !current };
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Storage is a convenience; the section still toggles for this visit.
      }
      return next;
    });
  };
  return { open, toggle };
}

function NavLink({
  item,
  active,
  badge,
  indent,
}: {
  item: NavItem;
  active: boolean;
  badge?: number;
  indent?: boolean;
}) {
  return (
    <Link
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-[11px] border-l-2 py-[8px] text-[13.5px] font-[550] no-underline transition-all',
        indent ? 'pl-[26px] pr-[18px]' : 'px-[18px]',
        FOCUS_RING,
        active
          ? 'border-ember-400 bg-ink-700 text-paper-100'
          : 'border-transparent text-paper-500 hover:text-paper-200'
      )}
      href={item.href}
    >
      <NavIcon name={item.icon} />
      <span className="flex-1">{item.label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="rounded-full bg-ember-400 px-[7px] py-px text-[10.5px] font-bold text-paper-50">
          {badge}
        </span>
      )}
    </Link>
  );
}

/**
 * The signed-in user: name and role at a glance, and a small menu with the
 * account actions (Settings, Sign out). It replaces a chip that was labelled as
 * a team switcher but showed the user, and a footer that repeated it.
 */
function UserMenu() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const router = useRouter();
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
        // Stop the mobile drawer's own Escape handler from also closing the drawer.
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

  const name = user?.email?.split('@')[0] ?? 'user';
  const handleLogout = async () => {
    // logout() clears the gateway session and local cookies; navigating before
    // it settles can land on /login with the old session still valid.
    await logout();
    router.push('/login');
  };

  return (
    <div className="relative mx-[14px] mb-[10px]" ref={root}>
      <button
        aria-controls={MENU_ID}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-[9px] rounded-lg border border-ink-400 bg-ink-700 px-[11px] py-[9px] text-left text-[12.5px] hover:border-ink-300',
          FOCUS_RING
        )}
        onClick={() => setOpen((o) => !o)}
        ref={trigger}
        type="button"
      >
        <span
          aria-hidden="true"
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-sm bg-gradient-to-br from-dust-400 to-ember-400 text-[11px] font-bold text-ink-950"
        >
          {name[0].toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-semibold text-paper-200">{name}</span>
          {(user?.role?.toLowerCase() ?? 'member') !== name.toLowerCase() && (
            <span className="block text-[11px] text-paper-400">
              {user?.role?.toLowerCase() ?? 'member'}
            </span>
          )}
        </span>
        <span aria-hidden="true" className="text-[10px] text-paper-500">
          ▾
        </span>
      </button>
      {open && (
        <div
          className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-ink-400 bg-ink-900 shadow-xl"
          id={MENU_ID}
        >
          <div className="truncate border-b border-ink-400 px-3 py-2 text-xs text-paper-400">
            {user?.email ?? 'guest'}
          </div>
          <Link
            className={cn(
              'block px-3 py-2 text-[13px] text-paper-200 no-underline hover:bg-ink-700',
              FOCUS_RING
            )}
            href="/settings"
            onClick={() => setOpen(false)}
          >
            Settings
          </Link>
          <button
            className={cn(
              'block w-full px-3 py-2 text-left text-[13px] text-paper-200 hover:bg-ink-700',
              FOCUS_RING
            )}
            onClick={handleLogout}
            type="button"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/** The user menu is a plain disclosure (links and a button), not an ARIA menu. */
const MENU_ID = 'user-menu';

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

  const sections = useOpenSections(user?.sub ?? 'anonymous');

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
        <Link
          className={cn('flex items-center gap-3 px-[18px] py-[18px] no-underline', FOCUS_RING)}
          href="/"
        >
          {/* Gradient logo mark */}
          <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-sm bg-gradient-to-br from-ember-400 to-violet-400 shadow-[0_6px_18px_-6px_color-mix(in_oklab,var(--color-ember-400)_70%,transparent)]">
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
          className={cn(
            'mr-3 rounded-md p-2 text-paper-400 hover:text-paper-100 md:hidden',
            FOCUS_RING
          )}
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

      <UserMenu />

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto pb-4">
        <div className="px-[14px] pt-1">
          <Link
            aria-current={isStartWorkPath(pathname) ? 'page' : undefined}
            className={cn(
              'flex items-center justify-center gap-2 rounded-lg border border-transparent bg-gradient-to-br from-ember-500 to-ember-600 px-3 py-[9px] text-[13.5px] font-semibold text-white no-underline hover:brightness-110',
              FOCUS_RING
            )}
            href="/start"
          >
            <span aria-hidden="true">+</span>
            Start work
          </Link>
        </div>
        {groups.map((group) => (
          <div key={group.label}>
            <div className="px-5 pb-[6px] pt-[14px] text-[11px] font-bold uppercase tracking-[0.12em] text-paper-400">
              {group.label}
            </div>
            {navSections(group.items).map((section) => {
              const links = (indent: boolean) =>
                section.items.map((item) => (
                  <NavLink
                    active={activeHref === item.href}
                    badge={item.href === '/govern/approvals' ? inboxCount : undefined}
                    indent={indent}
                    item={item}
                    key={item.href}
                  />
                ));
              if (section.label === null) {
                return links(false);
              }
              const label = section.label;
              const holdsActive = section.items.some((i) => i.href === activeHref);
              const panelId = `nav-section-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
              const isOpen = holdsActive || (sections.open[label] ?? true);
              return (
                <div key={label}>
                  <button
                    aria-controls={panelId}
                    // Not `disabled`: the section holding the current page cannot collapse, but
                    // it stays focusable so a screen reader still finds and announces it.
                    aria-disabled={holdsActive}
                    aria-expanded={isOpen}
                    className={cn(
                      'flex w-full items-center gap-2 px-[18px] py-[7px] text-left text-[12px] font-semibold text-paper-400 hover:text-paper-200',
                      FOCUS_RING,
                      holdsActive && 'cursor-default'
                    )}
                    onClick={() => {
                      if (!holdsActive) {
                        sections.toggle(label, isOpen);
                      }
                    }}
                    type="button"
                  >
                    <svg
                      aria-hidden="true"
                      className={cn('shrink-0 transition-transform', isOpen && 'rotate-90')}
                      fill="none"
                      height={12}
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2.2}
                      viewBox="0 0 24 24"
                      width={12}
                    >
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                    {label}
                  </button>
                  <div id={panelId}>{isOpen && links(true)}</div>
                </div>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
