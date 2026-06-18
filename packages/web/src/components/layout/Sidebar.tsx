'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useInbox } from '@/hooks/useWorkflows';
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
    items: [
      { href: '/', icon: 'dashboard', label: 'Dashboard', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
      { href: '/runs', icon: 'runs', label: 'Runs', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
      { href: '/inbox', icon: 'inbox', label: 'Inbox', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
    ],
    label: 'Operate',
  },
  {
    items: [
      {
        href: '/templates',
        icon: 'templates',
        label: 'Templates',
        roles: ['ENGINEER', 'LEAD', 'ADMIN'],
      },
      {
        href: '/workflows',
        icon: 'canvas',
        label: 'Canvas',
        roles: ['ENGINEER', 'LEAD', 'ADMIN'],
      },
      { href: '/epics', icon: 'epics', label: 'Epics', roles: ['LEAD', 'ADMIN'] },
    ],
    label: 'Build',
  },
  {
    items: [
      {
        href: '/admin/agents/library',
        icon: 'agents',
        label: 'Agents',
        roles: ['ADMIN'],
      },
      { href: '/admin/skills', icon: 'skills', label: 'Skills', roles: ['ADMIN'] },
      {
        href: '/repositories',
        icon: 'connections',
        label: 'Connections',
        roles: ['LEAD', 'ADMIN'],
      },
    ],
    label: 'Libraries',
  },
  {
    items: [
      {
        href: '/analytics',
        icon: 'analytics',
        label: 'Analytics',
        roles: ['ENGINEER', 'LEAD', 'ADMIN'],
      },
      {
        href: '/lessons',
        icon: 'memory',
        label: 'Memory',
        roles: ['ENGINEER', 'LEAD', 'ADMIN'],
      },
      {
        href: '/admin/security',
        icon: 'security',
        label: 'Security',
        roles: ['ADMIN'],
      },
    ],
    label: 'Insights',
  },
  {
    items: [
      { href: '/teams', icon: 'teams', label: 'Teams', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
      { href: '/users', icon: 'users', label: 'Users', roles: ['ADMIN'] },
      {
        href: '/admin/integrations',
        icon: 'connections',
        label: 'Integrations',
        roles: ['ADMIN'],
      },
      {
        href: '/admin/model-config',
        icon: 'admin',
        label: 'Model Config',
        roles: ['ADMIN'],
      },
      {
        href: '/admin/mcp-connections',
        icon: 'connections',
        label: 'MCP Connections',
        roles: ['ADMIN'],
      },
      {
        href: '/admin/scanner',
        icon: 'security',
        label: 'Scanner',
        roles: ['ADMIN'],
      },
      {
        href: '/admin/workflow',
        icon: 'workflows',
        label: 'Workflow Defaults',
        roles: ['ADMIN'],
      },
      {
        href: '/admin/schedules',
        icon: 'templates',
        label: 'Schedules',
        roles: ['ADMIN'],
      },
      {
        href: '/admin/sessions',
        icon: 'clock',
        label: 'Sessions',
        roles: ['ADMIN'],
      },
      {
        href: '/admin/access-tokens',
        icon: 'key',
        label: 'API Tokens',
        roles: ['ADMIN'],
      },
      {
        href: '/admin/lessons',
        icon: 'memory',
        label: 'Lessons',
        roles: ['ADMIN'],
      },
      { href: '/docs', icon: 'docs', label: 'Docs', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
      {
        href: '/settings',
        icon: 'settings',
        label: 'Settings',
        roles: ['ENGINEER', 'LEAD', 'ADMIN'],
      },
    ],
    label: 'Admin',
  },
];

const ROLE_HIERARCHY: Record<string, number> = { ADMIN: 3, ENGINEER: 1, LEAD: 2 };

function isActive(pathname: string, href: string): boolean {
  if (href === '/') {
    return pathname === '/';
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar() {
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  const userLevel = ROLE_HIERARCHY[user?.role ?? 'ENGINEER'] ?? 1;
  const { data: inboxSteps } = useInbox();
  const inboxCount = (inboxSteps ?? []).length;

  const avatarLetter = (user?.email ?? 'G')[0].toUpperCase();

  return (
    <aside
      className="flex flex-col border-r"
      style={{
        background: 'var(--color-ink-900)',
        borderColor: 'var(--color-ink-400)',
        width: 234,
      }}
    >
      {/* Brand */}
      <Link
        className="flex items-center gap-3 px-[18px] py-[18px]"
        href="/"
        style={{ textDecoration: 'none' }}
      >
        {/* Gradient logo mark */}
        <span
          className="flex shrink-0 items-center justify-center"
          style={{
            background: 'linear-gradient(135deg, var(--color-ember-400), var(--color-violet-400))',
            borderRadius: 7,
            boxShadow: '0 6px 18px -6px rgba(124, 108, 255, 0.7)',
            height: 26,
            width: 26,
          }}
        >
          <svg aria-hidden="true" fill="none" height={15} viewBox="0 0 24 24" width={15}>
            <path
              d="M4 7h7M4 12h16M13 17h7"
              stroke="#fff"
              strokeLinecap="round"
              strokeWidth={2.2}
            />
            <circle cx={17} cy={7} fill="#fff" r={2.4} />
            <circle cx={7} cy={17} fill="#fff" r={2.4} />
          </svg>
        </span>
        <span className="flex items-baseline gap-[3px]">
          <span
            style={{
              color: 'var(--color-paper-100)',
              fontSize: 15,
              fontWeight: 700,
              letterSpacing: '-0.02em',
            }}
          >
            auto
          </span>
          <span
            style={{
              color: 'var(--color-ember-400)',
              fontFamily: 'var(--font-display)',
              fontSize: 15,
              fontStyle: 'italic',
              fontWeight: 600,
            }}
          >
            ·swe
          </span>
        </span>
      </Link>

      {/* Team context chip */}
      <div
        className="mx-[14px] mb-[10px] flex items-center gap-[9px] px-[11px] py-[9px]"
        style={{
          background: 'var(--color-ink-700)',
          border: '1px solid var(--color-ink-400)',
          borderRadius: 10,
          cursor: 'default',
          fontSize: 12.5,
        }}
      >
        <span
          className="flex shrink-0 items-center justify-center"
          style={{
            background: 'linear-gradient(135deg, var(--color-dust-400), var(--color-ember-400))',
            borderRadius: 6,
            color: '#fff',
            fontSize: 11,
            fontWeight: 700,
            height: 22,
            width: 22,
          }}
        >
          {avatarLetter}
        </span>
        <div className="min-w-0 flex-1">
          <div
            style={{
              color: 'var(--color-paper-200)',
              fontSize: 12.5,
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {user?.email?.split('@')[0] ?? 'user'}
          </div>
          <div style={{ color: 'var(--color-paper-500)', fontSize: 10.5 }}>
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
              <div
                className="px-5 pb-[6px] pt-[14px]"
                style={{
                  color: 'var(--color-paper-600)',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                }}
              >
                {group.label}
              </div>
              {visible.map((item) => {
                const active = isActive(pathname, item.href);
                return (
                  <Link
                    className={cn(
                      'flex items-center gap-[11px] px-[18px] py-[8px] transition-all',
                      active ? 'text-paper-100' : 'text-paper-500 hover:text-paper-200'
                    )}
                    href={item.href}
                    key={item.href}
                    style={{
                      background: active ? 'var(--color-ink-700)' : undefined,
                      borderLeft: `2px solid ${active ? 'var(--color-ember-400)' : 'transparent'}`,
                      fontSize: 13.5,
                      fontWeight: 550,
                      textDecoration: 'none',
                    }}
                  >
                    <NavIcon name={item.icon} />
                    <span className="flex-1">{item.label}</span>
                    {item.href === '/inbox' && inboxCount > 0 && (
                      <span
                        style={{
                          background: 'var(--color-ember-400)',
                          borderRadius: 999,
                          color: '#fff',
                          fontSize: 10.5,
                          fontWeight: 700,
                          padding: '1px 7px',
                        }}
                      >
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
      <div className="px-[18px] py-[14px]" style={{ borderTop: '1px solid var(--color-ink-400)' }}>
        <div className="flex items-center gap-3">
          <span
            className="flex shrink-0 items-center justify-center"
            style={{
              background: 'var(--color-ink-500)',
              borderRadius: 8,
              color: 'var(--color-paper-300)',
              fontSize: 11,
              fontWeight: 600,
              height: 28,
              width: 28,
            }}
          >
            {avatarLetter}
          </span>
          <div className="min-w-0 flex-1">
            <div
              style={{
                color: 'var(--color-paper-400)',
                fontSize: 12,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {user?.email ?? 'guest'}
            </div>
          </div>
          <span
            style={{
              color: 'var(--color-ember-400)',
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
            }}
          >
            {user?.role ?? '—'}
          </span>
        </div>
      </div>
    </aside>
  );
}
