import { cn, formatDate, formatRelativeTime } from '@/lib/utils';

/** A timestamp shown relative ("3 hours ago") with the exact time on hover. */
export function RelativeTime({ className, value }: { className?: string; value: string }) {
  return (
    <time
      className={cn('whitespace-nowrap tabular-nums', className)}
      dateTime={value}
      title={formatDate(value, { showSeconds: true })}
    >
      {formatRelativeTime(value)}
    </time>
  );
}
