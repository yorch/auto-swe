import { cn } from '@/lib/utils';

/** The count of items waiting on the caller, as a small pill; nothing at zero. */
export function NeedsYouBadge({ className, count }: { count: number; className?: string }) {
  if (count <= 0) {
    return null;
  }
  return (
    <span
      className={cn(
        'rounded-full bg-accent-500 px-1.5 py-px text-xs font-semibold tabular-nums text-white',
        className
      )}
      data-testid="needs-you-badge"
    >
      {count}
      <span className="sr-only"> need you</span>
    </span>
  );
}
