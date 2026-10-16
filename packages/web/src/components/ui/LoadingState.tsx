import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Loading placeholders. Each one echoes the shape of the content it stands in
 * for, so the layout does not jump on arrival, and announces itself as a busy
 * status whose visually hidden label names what is loading ("Loading runs").
 * The shimmer is a CSS animation, so the global `prefers-reduced-motion` rule
 * in `globals.css` stills it.
 */

/** The shape of content a placeholder stands in for. */
export type SkeletonShape = 'rows' | 'cards' | 'form' | 'detail';

/** "runs" -> "Loading runs"; an empty label -> "Loading". */
export function loadingLabel(what?: string): string {
  const trimmed = what?.trim();
  return trimmed ? `Loading ${trimmed}` : 'Loading';
}

function SkeletonStatus({
  label,
  className,
  children,
}: {
  /** What is loading, without the verb — "runs". */
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div aria-busy="true" aria-live="polite" className={className} role="status">
      <span className="sr-only">{loadingLabel(label)}</span>
      {children}
    </div>
  );
}

/** A shimmering placeholder block; size it with `className` (`h-4 w-40`). */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('skeleton rounded-md', className)} />;
}

/** `rows` placeholder lines for a list or table body that is still loading. */
export function SkeletonRows({
  rows = 4,
  className,
  label,
}: {
  rows?: number;
  className?: string;
  label?: string;
}) {
  return (
    <SkeletonStatus className={cn('space-y-3 py-2', className)} label={label}>
      {Array.from({ length: rows }, (_, i) => `skeleton-row-${i}`).map((key) => (
        <div className="flex items-center gap-4" key={key}>
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </SkeletonStatus>
  );
}

/** A responsive grid of `cards` bordered tiles, each a title line and two body lines. */
export function SkeletonCards({
  cards = 3,
  className,
  label,
}: {
  cards?: number;
  className?: string;
  label?: string;
}) {
  return (
    <SkeletonStatus className={cn('py-2', className)} label={label}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: cards }, (_, i) => `skeleton-card-${i}`).map((key) => (
          <div className="space-y-3 rounded-lg border border-ink-700 p-4" key={key}>
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ))}
      </div>
    </SkeletonStatus>
  );
}

/** `fields` stacked label-over-input pairs and a button, for a settings or edit form. */
export function SkeletonForm({
  fields = 3,
  className,
  label,
}: {
  fields?: number;
  className?: string;
  label?: string;
}) {
  return (
    <SkeletonStatus className={cn('space-y-5 py-2', className)} label={label}>
      {Array.from({ length: fields }, (_, i) => `skeleton-field-${i}`).map((key) => (
        <div className="space-y-2" key={key}>
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
      <Skeleton className="h-8 w-24" />
    </SkeletonStatus>
  );
}

/** A heading with a metadata line, then a few paragraphs, for a single-record page. */
export function SkeletonDetail({ className, label }: { className?: string; label?: string }) {
  return (
    <SkeletonStatus className={cn('space-y-6 py-2', className)} label={label}>
      <div className="space-y-3">
        <Skeleton className="h-7 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
      <Skeleton className="h-24 w-full" />
    </SkeletonStatus>
  );
}

/** Renders the placeholder for `shape`. */
export function SkeletonFor({
  shape,
  label,
  rows,
  className,
}: {
  shape: SkeletonShape;
  label?: string;
  /** Row count for `rows`, card count for `cards`, field count for `form`. */
  rows?: number;
  className?: string;
}) {
  switch (shape) {
    case 'cards':
      return <SkeletonCards cards={rows} className={className} label={label} />;
    case 'form':
      return <SkeletonForm className={className} fields={rows} label={label} />;
    case 'detail':
      return <SkeletonDetail className={className} label={label} />;
    default:
      return <SkeletonRows className={className} label={label} rows={rows} />;
  }
}
