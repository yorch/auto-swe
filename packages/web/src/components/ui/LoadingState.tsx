import { cn } from '@/lib/utils';

/**
 * Loading indicator. The default is a centred block for whole-page / whole-card
 * loads; `compact` is a single left-aligned line for a section inside a card
 * that used to render its own "Loading…" paragraph.
 */
export function LoadingState({
  compact = false,
  message = 'loading…',
}: {
  compact?: boolean;
  message?: string;
}) {
  return (
    <div className={cn('flex items-center', compact ? 'py-2' : 'justify-center py-12')}>
      <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.2em] text-paper-500">
        <span
          aria-hidden
          className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-ember-400"
        />
        {message}
      </div>
    </div>
  );
}
