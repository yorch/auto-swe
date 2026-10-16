'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { BrandMark } from '@/components/layout/AuthLayout';
import { PALETTE_CHOICES } from '@/components/layout/ThemeToggle';
import { Icon, isIconName } from '@/components/ui/Icon';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/SegmentedControl';
import { useApprovalsCount } from '@/hooks/useApprovals';
import { useVisibleNavGroups } from '@/hooks/useVisibleNav';
import { APPROVALS_HREF, activeNavHref, isStartWorkPath, type NavItem } from '@/lib/navigation';
import { cn, FOCUS_RING } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import { type PalettePreference, type ThemePreference, useThemeStore } from '@/stores/themeStore';

function NavLink({ item, active, badge }: { item: NavItem; active: boolean; badge?: number }) {
  return (
    <Link
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative mx-2.5 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium no-underline transition-colors',
        FOCUS_RING,
        active
          ? 'bg-ink-600 text-paper-50 before:absolute before:inset-y-1.5 before:-left-2.5 before:w-[3px] before:rounded-r-full before:bg-ember-400'
          : 'text-paper-500 hover:bg-ink-700/70 hover:text-paper-200'
      )}
      data-tour={`nav:${item.href}`}
      href={item.href}
    >
      <Icon
        className={active ? 'text-ember-300' : undefined}
        name={isIconName(item.icon) ? item.icon : 'dashboard'}
        size={15}
      />
      <span className="flex-1">{item.label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="rounded-full bg-ember-500 px-1.5 py-px text-xs font-semibold tabular-nums text-white">
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
  const palette = useThemeStore((s) => s.palette);
  const setPalette = useThemeStore((s) => s.setPalette);
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
          'flex w-full items-center gap-2.5 rounded-lg border border-ink-500 bg-ink-700/60 px-2.5 py-2 text-left text-sm transition-colors hover:border-ink-300 hover:bg-ink-700',
          FOCUS_RING
        )}
        onClick={() => setOpen((o) => !o)}
        ref={trigger}
        type="button"
      >
        <span
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-ink-300 bg-ink-600 text-xs font-semibold text-paper-100"
        >
          {name[0].toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-paper-200">{name}</span>
          {(user?.role?.toLowerCase() ?? 'member') !== name.toLowerCase() && (
            <span className="block text-xs text-paper-400">
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
            <div className="mt-2.5 mb-1.5 text-xs text-paper-500">Palette</div>
            <SegmentedControl
              ariaLabel="Palette"
              className="w-full"
              onChange={setPalette}
              optionClassName="flex-1"
              options={PALETTE_OPTIONS}
              value={palette}
            />
          </div>
          <Link
            className={cn(
              'block px-3 py-2 text-sm text-paper-200 no-underline hover:bg-ink-700',
              FOCUS_RING
            )}
            href="/settings"
            onClick={() => setOpen(false)}
          >
            Settings
          </Link>
          <button
            className={cn(
              'block w-full px-3 py-2 text-left text-sm text-paper-200 hover:bg-ink-700',
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

const PALETTE_OPTIONS: SegmentedOption<PalettePreference>[] = PALETTE_CHOICES.map((c) => ({
  label: c.label,
  title: c.title,
  value: c.value,
}));

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
  const inboxCount = useApprovalsCount();

  const groups = useVisibleNavGroups();
  // The most-specific matching sidebar item wins; every /admin page lights the Admin entry.
  const activeHref = useMemo(
    () =>
      activeNavHref(
        pathname,
        groups.flatMap((g) => g.items)
      ),
    [pathname, groups]
  );

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
      data-tour="sidebar"
      id={SIDEBAR_ID}
    >
      <div className="flex items-center justify-between">
        {/* Brand */}
        <Link
          className={cn('flex items-center gap-3 px-[18px] py-[18px] no-underline', FOCUS_RING)}
          href="/"
        >
          <BrandMark size="sm" />
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
              'flex items-center justify-center gap-2 rounded-lg border border-transparent bg-ember-500 px-3 py-2 text-sm font-semibold text-white no-underline transition-colors hover:bg-ember-600',
              FOCUS_RING
            )}
            data-tour="nav:/start"
            href="/start"
          >
            <Icon name="plus" size={14} strokeWidth={2.4} />
            Start work
          </Link>
        </div>
        {groups.map((group) => (
          <div key={group.label}>
            {/* A group that is one entry of the same name (Admin) needs no heading over it. */}
            {group.items.length === 1 && group.items[0].label === group.label ? (
              <div className="pt-4" />
            ) : (
              <div className="px-5 pt-5 pb-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-paper-600">
                {group.label}
              </div>
            )}
            {group.items.map((item) => (
              <NavLink
                active={activeHref === item.href}
                badge={item.href === APPROVALS_HREF ? inboxCount : undefined}
                item={item}
                key={item.href}
              />
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}
