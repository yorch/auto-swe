'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuthStore } from '@/stores/authStore';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
  { href: '/workflows', label: 'Workflows', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
  { href: '/epics', label: 'Epics', roles: ['LEAD', 'ADMIN'] },
  { href: '/teams', label: 'Teams', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
  { href: '/repositories', label: 'Repositories', roles: ['LEAD', 'ADMIN'] },
  { href: '/users', label: 'Users', roles: ['ADMIN'] },
  { href: '/lessons', label: 'Lessons', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
  { href: '/settings', label: 'Settings', roles: ['ENGINEER', 'LEAD', 'ADMIN'] },
];

const ROLE_HIERARCHY: Record<string, number> = { ADMIN: 3, LEAD: 2, ENGINEER: 1 };

export function Sidebar() {
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  const userLevel = ROLE_HIERARCHY[user?.role ?? 'ENGINEER'] ?? 1;

  const visibleItems = NAV_ITEMS.filter((item) =>
    item.roles.some((r) => (ROLE_HIERARCHY[r] ?? 0) <= userLevel),
  );

  return (
    <aside className="w-56 border-r border-[var(--border)] bg-white flex flex-col">
      <div className="p-4 border-b border-[var(--border)]">
        <h1 className="text-lg font-bold tracking-tight">auto-swe</h1>
        <p className="text-xs text-[var(--muted-foreground)]">Engineering Automation</p>
      </div>
      <nav className="flex-1 p-2 space-y-1">
        {visibleItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'block px-3 py-2 rounded-md text-sm transition-colors',
              pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href))
                ? 'bg-[var(--primary)] text-white'
                : 'text-[var(--foreground)] hover:bg-[var(--muted)]',
            )}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="p-4 border-t border-[var(--border)] text-xs text-[var(--muted-foreground)]">
        {user?.role ?? 'Guest'}
      </div>
    </aside>
  );
}
