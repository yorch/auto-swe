'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
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
      { href: '/workflows', label: 'Active Runs', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
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
      { href: '/docs', label: 'Docs', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
      { href: '/settings', label: 'Settings', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
    ],
    label: 'Admin',
  },
];

const ROLE_HIERARCHY: Record<string, number> = { ADMIN: 3, ENGINEER: 1, LEAD: 2 };

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar() {
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  const userLevel = ROLE_HIERARCHY[user?.role ?? 'ENGINEER'] ?? 1;

  let counter = 0;

  return (
    <aside className="flex w-64 flex-col border-r border-ink-600 bg-ink-950/60 backdrop-blur-sm">
      {/* Wordmark */}
      <div className="px-6 pt-7 pb-6">
        <Link className="group block" href="/">
          <div className="flex items-baseline gap-1.5">
            <span className="font-display text-2xl font-medium leading-none tracking-tight text-paper-100">
              auto
            </span>
            <span className="display-italic text-2xl leading-none text-ember-400">·swe</span>
          </div>
          <div className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
            engineering · telemetry
          </div>
        </Link>
      </div>

      <div className="ink-rule mx-6 h-px" />

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 pt-6 pb-4">
        {NAV_GROUPS.map((group) => {
          const visible = group.items.filter((item) =>
            item.roles.some((r) => (ROLE_HIERARCHY[r] ?? 0) <= userLevel)
          );
          if (visible.length === 0) return null;

          return (
            <div className="mb-6" key={group.label}>
              <div className="px-3 pb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-paper-500">
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
                          'group/item relative flex items-center gap-3 px-3 py-2 text-sm transition-colors',
                          active ? 'text-paper-50' : 'text-paper-400 hover:text-paper-100'
                        )}
                        href={item.href}
                      >
                        {/* Active accent rule (slides in on hover/active) */}
                        <span
                          className={cn(
                            'absolute left-0 top-1.5 bottom-1.5 w-[2px] bg-ember-400 transition-transform origin-top',
                            active ? 'scale-y-100' : 'scale-y-0 group-hover/item:scale-y-100'
                          )}
                        />
                        <span className="tabular w-5 font-mono text-[10px] text-paper-600">
                          {n}
                        </span>
                        <span className="flex-1 tracking-tight">{item.label}</span>
                        {active && <span className="font-mono text-[10px] text-ember-400">●</span>}
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

      {/* Footer: user */}
      <div className="px-6 py-5">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
          Session
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-2">
          <span className="truncate text-sm text-paper-200">{user?.email ?? 'guest'}</span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-ember-400">
            {user?.role ?? '—'}
          </span>
        </div>
      </div>
    </aside>
  );
}
