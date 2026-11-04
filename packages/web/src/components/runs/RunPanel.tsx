import type { ReactNode } from 'react';
import { cn, FOCUS_RING } from '@/lib/utils';

/**
 * A disclosure band on the run page: Callback, Transcripts, Evidence, Activity and Lessons.
 * They share one look — the page gutter (`px-4 md:px-6`), a rule underneath, a focus ring on the
 * summary — so they read as parts of one page rather than five unrelated boxes. `meta` is the
 * count or state beside the title, shown while the panel is closed.
 */
export function RunPanel({
  children,
  className,
  defaultOpen,
  id,
  meta,
  onToggle,
  title,
}: {
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
  id?: string;
  meta?: ReactNode;
  onToggle?: (open: boolean) => void;
  title: string;
}) {
  return (
    <details
      className={cn(
        'group shrink-0 border-b border-ink-700 bg-ink-900 px-4 py-3 text-sm text-paper-300 md:px-6',
        className
      )}
      id={id}
      onToggle={onToggle ? (event) => onToggle(event.currentTarget.open) : undefined}
      open={defaultOpen}
    >
      <summary
        className={cn(
          'flex min-h-[40px] cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 rounded-sm font-medium text-paper-200 lg:min-h-0 [&::-webkit-details-marker]:hidden',
          FOCUS_RING
        )}
      >
        <svg
          aria-hidden="true"
          className="shrink-0 text-paper-500 transition-transform group-open:rotate-90"
          fill="none"
          height="12"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="12"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
        {title}
        {meta && <span className="text-xs font-normal text-paper-500">{meta}</span>}
      </summary>
      {children}
    </details>
  );
}
