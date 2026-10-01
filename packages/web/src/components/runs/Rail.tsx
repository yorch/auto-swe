import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * One block of the run detail's right-hand rail: a hairline divider above it
 * (omit for the first block), an ember kicker, then the block's content.
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
        {title && <div className="kicker mb-2">{title}</div>}
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
        'flex items-center justify-between gap-3 border-b border-ink-600 py-1.5 last:border-0',
        className
      )}
    >
      {children}
    </div>
  );
}
