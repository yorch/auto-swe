'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { Icon, isIconName } from '@/components/ui/Icon';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/SegmentedControl';
import { useApprovalsCount } from '@/hooks/useApprovals';
import { useVisibleNavGroups } from '@/hooks/useVisibleNav';
import { activeNavHref, isStartWorkPath, type NavItem, navSections } from '@/lib/navigation';
import { cn, FOCUS_RING } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import { type ThemePreference, useThemeStore } from '@/stores/themeStore';

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
        'relative mx-2.5 flex items-center gap-2.5 rounded-md py-1.5 text-[13px] font-medium no-underline transition-colors',
        indent ? 'pr-2.5 pl-6' : 'px-2.5',
        FOCUS_RING,
        active
          ? 'bg-ink-600 text-paper-50 before:absolute before:inset-y-1.5 before:-left-2.5 before:w-[3px] before:rounded-r-full before:bg-ember-400'
          : 'text-paper-500 hover:bg-ink-700/70 hover:text-paper-200'
      )}
      href={item.href}
    >
      <Icon
        className={active ? 'text-ember-300' : undefined}
        name={isIconName(item.icon) ? item.icon : 'dashboard'}
        size={15}
      />
      <span className="flex-1">{item.label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="rounded-full bg-ember-500 px-1.5 py-px text-[10.5px] font-semibold tabular-nums text-white">
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

  const themePreference = useThemeStore((s) => s.preference);
  const setThemePreference = useThemeStore((s) => s.setPreference);
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
          'flex w-full items-center gap-2.5 rounded-lg border border-ink-500 bg-ink-700/60 px-2.5 py-2 text-left text-[12.5px] transition-colors hover:border-ink-300 hover:bg-ink-700',
          FOCUS_RING
        )}
        onClick={() => setOpen((o) => !o)}
        ref={trigger}
        type="button"
      >
        <span
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-dust-400 to-ember-400 text-[11px] font-bold text-ink-950"
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
        <Icon
          className={cn('text-paper-500 transition-transform', open && 'rotate-180')}
          name="chevronDown"
          size={14}
        />
      </button>
      {open && (
        <div
          className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-ink-400 bg-ink-900 shadow-xl"
          id={MENU_ID}
        >
          <div className="truncate border-b border-ink-400 px-3 py-2 text-xs text-paper-400">
            {user?.email ?? 'guest'}
          </div>
          <div className="border-b border-ink-400 px-3 py-2">
            <div className="mb-1.5 text-xs text-paper-500">Theme</div>
            <SegmentedControl
              ariaLabel="Theme"
              className="w-full"
              onChange={setThemePreference}
              optionClassName="flex-1"
              options={THEME_OPTIONS}
              value={themePreference}
            />
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

const THEME_OPTIONS: SegmentedOption<ThemePreference>[] = [
  { label: 'System', title: 'Follow your operating system', value: 'system' },
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
];

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

  const groups = useVisibleNavGroups();
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
        'flex w-[234px] flex-col border-r border-ink-500/70 bg-ink-900',
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
              'flex items-center justify-center gap-2 rounded-lg border border-transparent bg-gradient-to-br from-ember-500 to-ember-600 px-3 py-2 text-[13px] font-semibold text-white no-underline shadow-[0_8px_20px_-10px_var(--color-ember-500)] transition hover:brightness-110',
              FOCUS_RING
            )}
            href="/start"
          >
            <Icon name="plus" size={14} strokeWidth={2.4} />
            Start work
          </Link>
        </div>
        {groups.map((group) => (
          <div key={group.label}>
            <div className="px-5 pt-5 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-paper-600">
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
                      'mx-2.5 flex w-[calc(100%-1.25rem)] items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] font-medium text-paper-500 hover:text-paper-200',
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
