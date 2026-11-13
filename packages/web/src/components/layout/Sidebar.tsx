'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BrandMark } from '@/components/layout/AuthLayout';
import { PALETTE_CHOICES } from '@/components/layout/ThemeToggle';
import { SupportContact } from '@/components/SupportContact';
import { NeedsYouBadge } from '@/components/teams/NeedsYouBadge';
import { Icon, isIconName } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/SegmentedControl';
import { useApprovalsCount } from '@/hooks/useApprovals';
import { useTeamNav } from '@/hooks/useTeamNav';
import { useUserPreferences } from '@/hooks/useUserPreferences';
import { useVisibleNavGroups } from '@/hooks/useVisibleNav';
import { APPROVALS_HREF, activeNavHref, isStartWorkPath, type NavItem } from '@/lib/navigation';
import { teamHref, teamSlugFromPath } from '@/lib/teamSpace';
import { cn, FOCUS_RING } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import { type PalettePreference, type ThemePreference, useThemeStore } from '@/stores/themeStore';

function NavLink({ item, active, badge }: { item: NavItem; active: boolean; badge?: number }) {
  return (
    <Link
      aria-current={active ? 'page' : undefined}
      aria-label={item.label}
      className={cn(
        'relative mx-2.5 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium no-underline transition-colors pointer-coarse:min-h-[44px]',
        FOCUS_RING,
        active
          ? 'bg-ink-600 text-paper-50 before:absolute before:inset-y-1.5 before:-left-2.5 before:w-[3px] before:rounded-r-full before:bg-accent-400'
          : 'text-paper-500 hover:bg-ink-700/70 hover:text-paper-200'
      )}
      data-rail-item
      data-sidebar-label={item.label}
      data-tour={`nav:${item.href}`}
      href={item.href}
    >
      <Icon
        className={active ? 'text-accent-300' : undefined}
        name={isIconName(item.icon) ? item.icon : 'dashboard'}
        size={15}
      />
      <span className="flex-1" data-rail-label>
        {item.label}
      </span>
      {badge !== undefined && badge > 0 && (
        <span
          className="rounded-full bg-accent-500 px-1.5 py-px text-xs font-semibold tabular-nums text-white"
          data-rail-label
        >
          {badge}
          <span className="sr-only"> pending</span>
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
    <div className="sidebar-user relative mx-[14px] mb-[10px]" ref={root}>
      <button
        aria-controls={MENU_ID}
        aria-expanded={open}
        aria-label={`User menu: ${name}`}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg border border-ink-500 bg-ink-700/60 px-2.5 py-2 text-left text-sm transition-colors pointer-coarse:min-h-[44px] hover:border-ink-300 hover:bg-ink-700',
          FOCUS_RING
        )}
        data-rail-item
        data-sidebar-label={`User menu: ${name}`}
        data-tour="sidebar:user-menu"
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
        <span className="min-w-0 flex-1" data-rail-label>
          <span className="block truncate text-sm font-semibold text-paper-200">{name}</span>
          {(user?.role?.toLowerCase() ?? 'member') !== name.toLowerCase() && (
            <span className="block text-xs text-paper-400">
              {user?.role?.toLowerCase() ?? 'member'}
            </span>
          )}
        </span>
        <Icon
          className={cn(
            'sidebar-user-chevron text-paper-500 transition-transform',
            open && 'rotate-180'
          )}
          name="chevronDown"
          size={14}
        />
      </button>
      {open && (
        <div
          className="sidebar-user-menu absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-ink-400 bg-ink-900 shadow-xl"
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
              'block px-3 py-2 text-sm text-paper-200 no-underline pointer-coarse:min-h-[44px] pointer-coarse:py-3 hover:bg-ink-700',
              FOCUS_RING
            )}
            href="/settings"
            onClick={() => setOpen(false)}
          >
            Settings
          </Link>
          <Link
            className={cn('block px-3 py-2 text-sm text-paper-200 hover:bg-ink-700', FOCUS_RING)}
            href="/docs"
            onClick={() => setOpen(false)}
          >
            Docs
          </Link>
          <SupportContact className="border-t border-ink-400 px-3 py-2" />
          <button
            className={cn(
              'block w-full px-3 py-2 text-left text-sm text-paper-200 pointer-coarse:min-h-[44px] hover:bg-ink-700',
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

/** The most teams the sidebar lists when none are pinned. */
const SIDEBAR_TEAM_LIMIT = 8;

/**
 * The caller's teams as links to their spaces, each with what is waiting on them. The teams the
 * user pinned come first (in pin order); with none pinned, the member teams, up to a limit (pins are not capped here: they have their own).
 */
function TeamsGroup({ pathname }: { pathname: string }) {
  const { entries } = useTeamNav();
  const { pinnedTeamSlugs } = useUserPreferences();
  const pinned = pinnedTeamSlugs
    .map((slug) => entries.find((e) => e.team.slug === slug))
    .filter((e): e is (typeof entries)[number] => !!e);
  const shown = pinned.length > 0 ? pinned : entries.slice(0, SIDEBAR_TEAM_LIMIT);
  if (shown.length === 0) {
    return null;
  }
  const currentSlug = teamSlugFromPath(pathname);
  return (
    <div data-rail-group>
      <div
        className="px-5 pt-5 pb-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-paper-600"
        data-rail-heading
        id="nav-group-teams"
      >
        Teams
      </div>
      <ul aria-labelledby="nav-group-teams">
        {shown.map(({ needsYou, team }) => {
          const active = team.slug === currentSlug;
          return (
            <li key={team.id}>
              <Link
                aria-current={active ? 'page' : undefined}
                aria-label={team.name}
                className={cn(
                  'relative mx-2.5 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium no-underline transition-colors pointer-coarse:min-h-[44px]',
                  FOCUS_RING,
                  active
                    ? 'bg-ink-600 text-paper-50'
                    : 'text-paper-500 hover:bg-ink-700/70 hover:text-paper-200'
                )}
                data-rail-item
                data-sidebar-label={team.name}
                href={teamHref(team.slug)}
              >
                <span aria-hidden="true" className="sidebar-team-initials hidden">
                  {team.name
                    .split(/\s+/)
                    .map((s) => s[0])
                    .join('')
                    .slice(0, 2)
                    .toUpperCase()}
                </span>
                <span data-rail-label>
                  <Icon name="teams" size={15} />
                </span>
                <span className="min-w-0 flex-1 truncate" data-rail-label>
                  {team.name}
                </span>
                <span data-rail-label>
                  <NeedsYouBadge count={needsYou} />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
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
  collapsed?: boolean;
  onToggle?: () => void;
}

export function Sidebar({
  open,
  onClose,
  closeButtonRef,
  collapsed = false,
  onToggle,
}: SidebarProps) {
  const pathname = usePathname();
  const inboxCount = useApprovalsCount();

  const groups = useVisibleNavGroups();
  const [tip, setTip] = useState<{ label: string; top: number; left: number } | null>(null);
  const showTip = (target: EventTarget) => {
    if (!(target instanceof Element)) {
      return;
    }
    const item = target.closest<HTMLElement>('[data-sidebar-label]');
    const sidebar = item?.closest('aside');
    if (!item || !sidebar || sidebar.getBoundingClientRect().width > 100) {
      return;
    }
    const rect = item.getBoundingClientRect();
    setTip({
      label: item.dataset.sidebarLabel ?? '',
      left: rect.right + 12,
      top: rect.top + rect.height / 2,
    });
  };
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
        'sidebar flex w-[234px] flex-col border-r border-ink-500/70 bg-ink-900',
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
      onBlur={() => setTip(null)}
      onClick={() => setTip(null)}
      onFocus={(e) => showTip(e.target)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
          setTip(null);
        }
      }}
      onMouseLeave={() => setTip(null)}
      onMouseOver={(e) => showTip(e.target)}
    >
      <div className="flex items-center justify-between">
        {/* Brand */}
        <Link
          aria-label="auto-swe home"
          className={cn(
            'sidebar-brand flex items-center gap-3 px-[18px] py-[18px] no-underline',
            FOCUS_RING
          )}
          href="/"
        >
          <span data-rail-label>
            <BrandMark size="sm" />
          </span>
        </Link>
        <button
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={cn(
            'sidebar-toggle hidden rounded-lg p-2 text-paper-400 hover:bg-ink-700 md:block',
            FOCUS_RING
          )}
          data-sidebar-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={onToggle}
          type="button"
        >
          <Icon name={collapsed ? 'arrowRight' : 'arrowLeft'} size={18} />
        </button>
        <IconButton
          aria-label="Close navigation"
          className="mr-3 md:hidden"
          onClick={onClose}
          ref={closeButtonRef}
          size="md"
        >
          <Icon name="close" size={18} />
        </IconButton>
      </div>

      <UserMenu />

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto pb-4">
        <div className="px-[14px] pt-1">
          <Link
            aria-current={isStartWorkPath(pathname) ? 'page' : undefined}
            aria-label="Start work"
            className={cn(
              'flex items-center justify-center gap-2 rounded-lg border border-transparent bg-accent-500 px-3 py-2 text-sm font-semibold text-white no-underline transition-colors pointer-coarse:min-h-[44px] hover:bg-accent-600',
              FOCUS_RING
            )}
            data-rail-item
            data-sidebar-label="Start work"
            data-tour="nav:/start"
            href="/start"
          >
            <Icon name="plus" size={14} strokeWidth={2.4} />
            <span data-rail-label>Start work</span>
          </Link>
        </div>
        {groups.map((group, index) => {
          // A group that is one entry of the same name (Admin) needs no heading over it.
          const headless = group.items.length === 1 && group.items[0].label === group.label;
          const headingId = `nav-group-${index}`;
          return (
            <div key={group.label}>
              {index === 1 && <TeamsGroup pathname={pathname} />}
              <div data-rail-group>
                {headless ? (
                  <div className="pt-4" />
                ) : (
                  <div
                    className="px-5 pt-5 pb-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-paper-600"
                    data-rail-heading
                    id={headingId}
                  >
                    {group.label}
                  </div>
                )}
                <ul
                  aria-label={headless ? group.label : undefined}
                  aria-labelledby={headless ? undefined : headingId}
                >
                  {group.items.map((item) => (
                    <li key={item.href}>
                      <NavLink
                        active={activeHref === item.href}
                        badge={item.href === APPROVALS_HREF ? inboxCount : undefined}
                        item={item}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          );
        })}
      </nav>

      <SupportContact className="sidebar-support shrink-0 border-t border-ink-500/70 px-[18px] py-3" />
      {tip &&
        createPortal(
          <div
            className="pointer-events-none fixed z-50 -translate-y-1/2 rounded-lg border border-ink-400 bg-ink-700 px-3 py-2 text-sm text-paper-100 shadow-lg"
            role="tooltip"
            style={{ left: tip.left, top: tip.top }}
          >
            {tip.label}
          </div>,
          document.body
        )}
    </aside>
  );
}
