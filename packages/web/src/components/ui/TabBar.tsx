import Link from 'next/link';
import { cn } from '@/lib/utils';

interface TabItem<T extends string> {
  id: T;
  label: string;
  /** Renders the tab as a link. Use it when each tab is its own route. */
  href?: string;
}

/**
 * Underlined section tabs. Tabs with an `href` are `next/link`s marked
 * `aria-current="page"` when active — sub-pages stay linkable, middle-clickable
 * and prefetched. Tabs without one call `onChange`, for in-page sections.
 */
export function TabBar<T extends string>({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: TabItem<T>[];
  active: T;
  onChange?: (id: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('border-b border-ink-600', className)}>
      <nav className="flex gap-1">
        {tabs.map((tab) => {
          const tabClassName = cn(
            'border-b-2 px-4 py-2 text-sm transition-colors',
            active === tab.id
              ? 'border-ember-400 text-ember-400'
              : 'border-transparent text-paper-400 hover:text-paper-100'
          );
          return tab.href ? (
            <Link
              aria-current={active === tab.id ? 'page' : undefined}
              className={tabClassName}
              href={tab.href}
              key={tab.id}
            >
              {tab.label}
            </Link>
          ) : (
            <button
              className={tabClassName}
              key={tab.id}
              onClick={() => onChange?.(tab.id)}
              type="button"
            >
              {tab.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
