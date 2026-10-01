'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo } from 'react';
import { useApprovalsCount } from '@/hooks/useApprovals';
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

type NavItem = {
  href: string;
  label: string;
  icon: string;
  roles: string[];
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    items: [{ href: '/', icon: 'dashboard', label: 'Home', roles: ['ENGINEER', 'LEAD', 'ADMIN'] }],
    label: 'Start',
  },
  {
    items: [
      { href: '/workflows', icon: 'canvas', label: 'Queue', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
    ],
    label: 'Requests',
  },
  {
    items: [
      {
        href: '/workflows/library',
        icon: 'templates',
        label: 'Library',
        roles: ['ENGINEER', 'LEAD', 'ADMIN'],
      },
      {
        href: '/connections',
        icon: 'connections',
        label: 'Connections',
        roles: ['LEAD', 'ADMIN'],
      },
      { href: '/runs', icon: 'runs', label: 'Runs', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
    ],
    label: 'Workflows',
  },
  {
    items: [
      {
        href: '/studio/agents/library',
        icon: 'agents',
        label: 'Agents',
        roles: ['ADMIN'],
      },
      { href: '/studio/skills', icon: 'skills', label: 'Skills', roles: ['LEAD', 'ADMIN'] },
      { href: '/studio/mcp', icon: 'connections', label: 'MCP', roles: ['LEAD', 'ADMIN'] },
      {
        href: '/studio/integrations',
        icon: 'connections',
        label: 'Integrations',
        roles: ['ADMIN'],
      },
      {
        href: '/studio/github-installations',
        icon: 'connections',
        label: 'GitHub installations',
        roles: ['ADMIN'],
      },
      { href: '/studio/models', icon: 'admin', label: 'Model config', roles: ['ADMIN'] },
      { href: '/studio/bundles', icon: 'templates', label: 'Bundles', roles: ['ADMIN'] },
    ],
    label: 'Studio',
  },
  {
    items: [
      { href: '/govern/security', icon: 'security', label: 'Security', roles: ['ADMIN'] },
      { href: '/govern/scanner', icon: 'security', label: 'Scanner', roles: ['ADMIN'] },
      { href: '/govern/policies', icon: 'security', label: 'Autonomy policies', roles: ['ADMIN'] },
      { href: '/govern/evals', icon: 'analytics', label: 'Evals', roles: ['ADMIN'] },
      { href: '/govern/schedules', icon: 'clock', label: 'Schedules', roles: ['ADMIN'] },
      {
        href: '/govern/budget-alerts',
        icon: 'security',
        label: 'Budget alerts',
        roles: ['ADMIN'],
      },
      {
        href: '/govern/teams',
        icon: 'teams',
        label: 'Teams',
        roles: ['ENGINEER', 'LEAD', 'ADMIN'],
      },
      {
        href: '/govern/organizations',
        icon: 'teams',
        label: 'Organizations',
        roles: ['ADMIN'],
      },
      { href: '/govern/users', icon: 'users', label: 'Users', roles: ['ADMIN'] },
      { href: '/govern/api-tokens', icon: 'key', label: 'API tokens', roles: ['ADMIN'] },
      {
        href: '/govern/approvals',
        icon: 'inbox',
        label: 'Approvals',
        roles: ['ENGINEER', 'LEAD', 'ADMIN'],
      },
      { href: '/govern/lessons', icon: 'memory', label: 'Lessons', roles: ['ADMIN'] },
      {
        href: '/govern/analytics',
        icon: 'analytics',
        label: 'Analytics',
        roles: ['ENGINEER', 'LEAD', 'ADMIN'],
      },
      { href: '/govern/usage', icon: 'analytics', label: 'LLM usage', roles: ['ADMIN'] },
      {
        href: '/govern/baselines',
        icon: 'analytics',
        label: 'Error baselines',
        roles: ['ADMIN'],
      },
      { href: '/govern/sessions', icon: 'clock', label: 'Sessions', roles: ['ADMIN'] },
      {
        href: '/govern/slack-channels',
        icon: 'teams',
        label: 'Slack channels',
        roles: ['ADMIN'],
      },
      {
        href: '/govern/workflow-defaults',
        icon: 'workflows',
        label: 'Workflow defaults',
        roles: ['ADMIN'],
      },
      {
        href: '/govern/platform-settings',
        icon: 'settings',
        label: 'Platform settings',
        roles: ['ADMIN', 'LEAD'],
      },
      {
        href: '/govern/config-grants',
        icon: 'settings',
        label: 'Config grants',
        roles: ['ADMIN'],
      },
      {
        href: '/govern/audit',
        icon: 'analytics',
        label: 'Audit log',
        roles: ['ADMIN'],
      },
    ],
    label: 'Govern',
  },
  {
    items: [
      {
        href: '/settings',
        icon: 'settings',
        label: 'Settings',
        roles: ['ENGINEER', 'LEAD', 'ADMIN'],
      },
    ],
    label: 'Account',
  },
];

const ROLE_HIERARCHY: Record<string, number> = { ADMIN: 3, ENGINEER: 1, LEAD: 2 };

// Active item is computed in the Sidebar component so the most-specific
// matching nav item wins (e.g. /workflows/library over /workflows).

export function Sidebar() {
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  const userLevel = ROLE_HIERARCHY[user?.role ?? 'ENGINEER'] ?? 1;
  const inboxCount = useApprovalsCount();

  const allowed = useMemo(
    () =>
      NAV_GROUPS.flatMap((group) =>
        group.items.filter((item) => item.roles.some((r) => (ROLE_HIERARCHY[r] ?? 0) <= userLevel))
      ),
    [userLevel]
  );
  const activeHref = useMemo(() => {
    if (pathname === '/') {
      return '/';
    }
    const match = allowed
      .filter(
        (item) =>
          item.href !== '/' && (pathname === item.href || pathname.startsWith(`${item.href}/`))
      )
      .sort((a, b) => b.href.length - a.href.length)[0];
    return match?.href ?? '';
  }, [pathname, allowed]);

  const avatarLetter = (user?.email ?? 'G')[0].toUpperCase();

  return (
    <aside className="flex w-[234px] flex-col border-r border-ink-400 bg-ink-900">
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
          <span className="font-display text-[15px] font-semibold italic text-ember-400">·swe</span>
        </span>
      </Link>

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
        {NAV_GROUPS.map((group) => {
          const visible = group.items.filter((item) =>
            item.roles.some((r) => (ROLE_HIERARCHY[r] ?? 0) <= userLevel)
          );
          if (visible.length === 0) {
            return null;
          }

          return (
            <div key={group.label}>
              <div className="px-5 pb-[6px] pt-[14px] text-[10px] font-bold uppercase tracking-[0.12em] text-paper-600">
                {group.label}
              </div>
              {visible.map((item) => {
                const active = activeHref === item.href;
                return (
                  <Link
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
          );
        })}
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
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ember-400">
            {user?.role ?? '—'}
          </span>
        </div>
      </div>
    </aside>
  );
}
