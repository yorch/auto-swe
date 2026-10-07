import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * One block of the run detail's right-hand rail: a hairline divider above it
 * (omit for the first block), a short sentence-case heading, then the block's
 * content — usually `RailRow`s inside a `<dl>`.
 */
export function RailSection({
  children,
  className,
  divider = true,
  title,
}: {
  children: ReactNode;
  className?: string;
  divider?: boolean;
  title?: string;
}) {
  return (
    <>
      {divider && <div className="mx-5 h-px bg-ink-500/40" />}
      <div className={cn('px-5 py-4', className)}>
        {title && <h2 className="mb-2 text-[13px] font-semibold text-paper-100">{title}</h2>}
        {children}
      </div>
    </>
  );
}

/** A label/value line inside a `RailSection`, with the rail's row divider. */
export function RailRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 border-b border-ink-600/70 py-1.5 last:border-0',
        className
      )}
    >
      {children}
    </div>
  );
}

/** The key of a rail row: muted, sentence case. */
export const RAIL_KEY = 'shrink-0 text-xs text-paper-500';

/** A rail value that is a plain figure or date. */
export const RAIL_VALUE = 'tabular text-[13px] text-paper-200';

/** A rail value that is an identifier: a scorer key, a workflow id, an event name. */
export const RAIL_CODE = 'font-mono text-xs text-paper-300';
