import { cn, STATUS_META } from '@/lib/utils';
import { Badge } from './Badge';

export function StatusBadge({ status, showDot = true }: { status: string; showDot?: boolean }) {
  const meta = STATUS_META[status] ?? STATUS_META.UNKNOWN;
  const isLive = meta.live;

  // The shape comes from Badge; the status palette overrides its tone colours.
  return (
    <Badge
      className={cn('gap-1.5 text-[11.5px] tracking-[0.06em]', meta.classes)}
      tone="neutral"
      variant="outline"
    >
      {showDot && (
        <span
          aria-hidden
          className={cn(
            'inline-block h-[5px] w-[5px] rounded-full shrink-0',
            meta.dotClass,
            isLive && 'pulse-dot'
          )}
        />
      )}
      <span>{status.replace(/_/g, ' ').toLowerCase()}</span>
    </Badge>
  );
}
