import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './Icon';

/**
 * The row of controls above a list: search on the left, filters beside it, and
 * view or bulk actions pushed right. Wraps on a narrow screen. Put it directly
 * above the table it filters, inside the same card, so the two read as one unit.
 */
export function Toolbar({
  children,
  className,
  end,
}: {
  children?: ReactNode;
  className?: string;
  /** Right-aligned controls (view toggles, export, a count). */
  end?: ReactNode;
}) {
  return (
    <div className={cn('mb-4 flex flex-wrap items-center gap-2', className)}>
      {children}
      {end && <div className="ml-auto flex flex-wrap items-center gap-2">{end}</div>}
    </div>
  );
}

/**
 * A search box with a leading magnifier, sized to sit in a `Toolbar`. Controlled:
 * the caller owns the value (and any debounce).
 */
export function SearchInput({
  className,
  label,
  onChange,
  placeholder = 'Search…',
  value,
}: {
  className?: string;
  /** Accessible name; the placeholder is not one. */
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <div className={cn('relative w-full sm:w-64', className)}>
      <Icon
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-paper-500"
        name="search"
        size={14}
      />
      <input
        aria-label={label}
        className="h-8 w-full rounded-md border border-ink-400 bg-ink-900/60 pr-2.5 pl-8 text-[13px] text-paper-100 outline-none transition-colors placeholder:text-paper-600 hover:border-ink-300 focus:border-ember-400 focus:ring-2 focus:ring-ember-400/20"
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        type="search"
        value={value}
      />
    </div>
  );
}
