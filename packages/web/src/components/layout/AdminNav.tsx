'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useId, useState } from 'react';
import { Icon, isIconName } from '@/components/ui/Icon';
import { useVisibleNavGroups } from '@/hooks/useVisibleNav';
import { ADMIN_HREF, activeNavHref, type NavItem, navSections } from '@/lib/navigation';
import { cn, FOCUS_RING } from '@/lib/utils';

/** The Admin pages the signed-in user may open, in sidebar order. */
export function useAdminPages(): NavItem[] {
  const groups = useVisibleNavGroups();
  return groups.flatMap((g) => g.items).find((i) => i.href === ADMIN_HREF)?.children ?? [];
}

function SubNavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium no-underline transition-colors',
        FOCUS_RING,
        active
          ? 'bg-ink-600 text-paper-50'
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
    </Link>
  );
}

/**
 * The Admin area's own navigation, in the settings-page pattern: its pages listed by
 * section beside the content. Below `lg`, where a second column would squeeze the page,
 * it folds into a disclosure naming the current page, closed by default and closed again
 * on every navigation.
 */
export function AdminNav() {
  const pathname = usePathname();
  const pages = useAdminPages();
  // Open for one path only, so any navigation folds the menu again.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = openFor === pathname;
  const panelId = useId();
  const activeHref = activeNavHref(pathname, pages);
  const current = pages.find((p) => p.href === activeHref);

  if (pages.length === 0) {
    return null;
  }

  return (
    <nav aria-label="Admin" className="lg:sticky lg:top-0 lg:self-start">
      <button
        aria-controls={panelId}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg border border-ink-500 bg-ink-800 px-3 py-2 text-left text-sm text-paper-200 lg:hidden',
          FOCUS_RING
        )}
        onClick={() => setOpenFor(open ? null : pathname)}
        type="button"
      >
        <Icon className="text-paper-500" name="admin" size={15} />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-paper-500">Admin</span>
          {current && (
            <>
              <span aria-hidden="true" className="px-1.5 text-paper-600">
                ›
              </span>
              {current.label}
            </>
          )}
        </span>
        <Icon
          className={cn('text-paper-500 transition-transform', open && 'rotate-180')}
          name="chevronDown"
          size={14}
        />
      </button>
      <div className={cn('mt-2 space-y-4 lg:mt-0 lg:block', !open && 'max-lg:hidden')} id={panelId}>
        <SubNavLink active={pathname === ADMIN_HREF} item={OVERVIEW} />
        {navSections(pages).map((section, i) => (
          <div key={section.label ?? ''}>
            {section.label && (
              <div
                className="px-2.5 pb-1 text-2xs font-semibold uppercase tracking-[0.08em] text-paper-600"
                id={`${panelId}-s${i}`}
              >
                {section.label}
              </div>
            )}
            <ul
              aria-labelledby={section.label ? `${panelId}-s${i}` : undefined}
              className="space-y-px"
            >
              {section.items.map((item) => (
                <li key={item.href}>
                  <SubNavLink active={item.href === activeHref} item={item} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

const OVERVIEW: NavItem = {
  href: ADMIN_HREF,
  icon: 'dashboard',
  label: 'Overview',
  minRole: 'ENGINEER',
};
