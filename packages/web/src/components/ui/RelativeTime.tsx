import { cn, formatDate, formatRelativeTime } from '@/lib/utils';

/**
 * A timestamp shown relative ("3h ago") with the exact time on hover and in the
 * `<time>` element for assistive tech. Use it for every "when" cell in a list.
 */
export function RelativeTime({ className, value }: { className?: string; value: string | Date }) {
  const date = new Date(value);
  return (
    <time
      className={cn('whitespace-nowrap tabular-nums', className)}
      dateTime={date.toISOString()}
      title={formatDate(date, { showSeconds: true })}
    >
      {formatRelativeTime(date)}
    </time>
  );
}
