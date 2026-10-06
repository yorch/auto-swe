import { formatDate, formatRelativeTime } from '@/lib/utils';

/** "3h ago", with the exact time on hover and in the `<time>` element for assistive tech. */
export function RelativeTime({ className, date }: { className?: string; date: string | Date }) {
  const value = new Date(date);
  return (
    <time className={className} dateTime={value.toISOString()} title={formatDate(value)}>
      {formatRelativeTime(value)}
    </time>
  );
}
