'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useInbox } from '@/hooks/useWorkflows';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

type NavItem = {
  href: string;
  label: string;
  roles: string[];
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { href: '/', label: 'Dashboard', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
      { href: '/workflows', label: 'Workflows', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
      { href: '/inbox', label: 'Inbox', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
      { href: '/runs', label: 'Run History', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
      { href: '/templates', label: 'Templates', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
      { href: '/analytics', label: 'Analytics', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
    ],
    label: 'Operations',
  },
  {
    items: [
      { href: '/epics', label: 'Epics', roles: ['LEAD', 'ADMIN'] },
      { href: '/teams', label: 'Teams', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
      { href: '/repositories', label: 'Repositories', roles: ['LEAD', 'ADMIN'] },
      { href: '/lessons', label: 'Lessons', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
    ],
    label: 'Workspace',
  },
  {
    items: [
      { href: '/users', label: 'Users', roles: ['ADMIN'] },
      { href: '/admin/sessions', label: 'Sessions', roles: ['ADMIN'] },
      { href: '/admin/access-tokens', label: 'PAT Admin', roles: ['ADMIN'] },
      { href: '/admin/model-config', label: 'Model Config', roles: ['ADMIN'] },
      { href: '/admin/agents', label: 'Agents', roles: ['ADMIN'] },
      { href: '/admin/skills', label: 'Skills', roles: ['ADMIN'] },
      { href: '/admin/schedules', label: 'Schedules', roles: ['ADMIN'] },
      { href: '/admin/lessons', label: 'Lessons', roles: ['ADMIN'] },
      { href: '/admin/integrations', label: 'Integrations', roles: ['ADMIN'] },
      { href: '/admin/security', label: 'Security Events', roles: ['ADMIN'] },
      { href: '/admin/scanner', label: 'Scanner Patterns', roles: ['ADMIN'] },
      { href: '/admin/workflow', label: 'Workflow Defaults', roles: ['ADMIN'] },
      { href: '/docs', label: 'Docs', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
      { href: '/settings', label: 'Settings', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
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

  let counter = 0;

  const avatarLetter = (user?.email ?? 'G')[0].toUpperCase();

  return (
    <aside
      className="flex flex-col border-r border-ink-600/60"
      style={{ background: 'var(--color-ink-900)' }}
    >
      {/* Brand block */}
      <div className="px-6 pt-7 pb-5">
        <Link className="block" href="/">
          <div className="flex items-baseline gap-1">
            <span
              className="text-[22px] leading-none tracking-tight text-paper-100"
              style={{ fontFamily: 'var(--font-display)', fontWeight: 500 }}
            >
              auto
            </span>
            <span
              className="text-ember-400 text-[22px] leading-none"
              style={{ fontFamily: 'var(--font-display)', fontWeight: 500 }}
            >
              ·
            </span>
            <span
              className="text-ember-400 text-[22px] leading-none"
              style={{
                fontFamily: 'var(--font-display)',
                fontStyle: 'italic',
                fontWeight: 500,
              }}
            >
              swe
            </span>
          </div>
          <div
            className="mt-1.5 text-paper-600"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '9px',
              letterSpacing: '0.28em',
              textTransform: 'uppercase',
            }}
          >
            ENGINEERING · TELEMETRY
          </div>
        </Link>
      </div>

      <div className="ink-rule mx-6 h-px" />

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 pt-5 pb-4">
        {NAV_GROUPS.map((group) => {
          const visible = group.items.filter((item) =>
            item.roles.some((r) => (ROLE_HIERARCHY[r] ?? 0) <= userLevel)
          );
          if (visible.length === 0) {
            return null;
          }

          return (
            <div className="mb-6" key={group.label}>
              {/* Group kicker */}
              <div
                className="px-3 pb-2 text-paper-600"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '10px',
                  letterSpacing: '0.22em',
                  textTransform: 'uppercase',
                }}
              >
                {group.label}
              </div>
              <ul className="space-y-px">
                {visible.map((item) => {
                  counter += 1;
                  const active = isActive(pathname, item.href);
                  const n = String(counter).padStart(2, '0');
                  return (
                    <li key={item.href}>
                      <Link
                        className={cn(
                          'group/item relative flex items-center gap-3 rounded-sm px-3 py-1.5 transition-colors',
                          active
                            ? 'bg-ink-600/30 text-paper-100'
                            : 'text-paper-500 hover:bg-ink-600/20 hover:text-paper-300'
                        )}
                        href={item.href}
                      >
                        {/* 2px accent bar on left edge */}
                        <span
                          className={cn(
                            'absolute left-0 top-1 bottom-1 w-0.5 origin-top transition-transform',
                            active
                              ? 'scale-y-100 bg-ember-400'
                              : 'scale-y-0 bg-ember-400 group-hover/item:scale-y-75'
                          )}
                        />
                        {/* 2-digit index */}
                        <span
                          className={cn(
                            'w-5 shrink-0',
                            active ? 'text-ember-400' : 'text-paper-600'
                          )}
                          style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}
                        >
                          {n}
                        </span>
                        {/* Label */}
                        <span className="flex-1 text-[13px] tracking-tight">{item.label}</span>
                        {/* Inbox count or active dot at far right */}
                        {item.href === '/inbox' && inboxCount > 0 ? (
                          <span
                            className="bg-ember-400 text-ink-950 rounded-full leading-5 px-1.5"
                            style={{ fontFamily: 'var(--font-mono)', fontSize: '9px' }}
                          >
                            {inboxCount}
                          </span>
                        ) : active ? (
                          <span
                            className="text-ember-400"
                            style={{ fontFamily: 'var(--font-mono)', fontSize: '8px' }}
                          >
                            ●
                          </span>
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="ink-rule mx-6 h-px" />

      {/* Footer: avatar + username + role tag */}
      <div className="px-5 py-4 flex items-center gap-3">
        {/* Round mono avatar */}
        <span
          className="flex items-center justify-center w-7 h-7 rounded-full bg-ink-500 text-paper-300 shrink-0 select-none"
          style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', fontWeight: 500 }}
        >
          {avatarLetter}
        </span>
        <div className="flex-1 min-w-0">
          <div className="truncate text-paper-400 text-[12px]">{user?.email ?? 'guest'}</div>
        </div>
        <span
          className="shrink-0 text-ember-400"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '9px',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
          }}
        >
          {user?.role ?? '—'}
        </span>
      </div>
    </aside>
  );
}
