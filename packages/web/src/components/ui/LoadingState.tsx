import { cn } from '@/lib/utils';

/**
 * Loading indicator. The default is a centred block for whole-page / whole-card
 * loads; `compact` is a single left-aligned line for a section inside a card
 * that used to render its own "Loading…" paragraph. For a list or table whose
 * shape is known, prefer `Skeleton` rows — the layout does not jump on arrival.
 */
export function LoadingState({
  compact = false,
  message = 'Loading…',
}: {
  compact?: boolean;
  message?: string;
}) {
  return (
    <div
      aria-live="polite"
      className={cn('flex items-center', compact ? 'py-2' : 'justify-center py-12')}
      role="status"
    >
      <div className="flex items-center gap-2.5 text-[13px] text-paper-500">
        <span
          aria-hidden
          className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink-400 border-t-ember-400"
        />
        {message}
      </div>
    </div>
  );
}

/** A shimmering placeholder block; size it with `className` (`h-4 w-40`). */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('skeleton rounded-md', className)} />;
}

/** `rows` placeholder lines for a list or table body that is still loading. */
export function SkeletonRows({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div aria-live="polite" className={cn('space-y-3 py-2', className)} role="status">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, i) => `skeleton-row-${i}`).map((key) => (
        <div className="flex items-center gap-4" key={key}>
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}
