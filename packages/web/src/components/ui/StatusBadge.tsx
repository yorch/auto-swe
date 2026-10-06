import { cn, STATUS_META } from '@/lib/utils';
import { Badge } from './Badge';

export function StatusBadge({ status, showDot = true }: { status: string; showDot?: boolean }) {
  const meta = STATUS_META[status] ?? STATUS_META.UNKNOWN;
  const isLive = meta.live;

  // The shape comes from Badge; the status palette overrides its tone colours.
  return (
    <Badge
      className={cn('gap-1.5 rounded-full pr-2 pl-1.5', meta.classes)}
      tone="neutral"
      variant="outline"
    >
      {showDot && (
        <span
          aria-hidden
          className={cn(
            'inline-block h-1.5 w-1.5 rounded-full shrink-0',
            meta.dotClass,
            isLive && 'pulse-dot'
          )}
        />
      )}
      {/* Lower-cased text, shown sentence-case: `first-letter` needs a block box. */}
      <span className="inline-block first-letter:uppercase">
        {status.replace(/_/g, ' ').toLowerCase()}
      </span>
    </Badge>
  );
}
