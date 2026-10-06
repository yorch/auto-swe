import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icon, type IconName } from './Icon';

/**
 * "Nothing here yet" for a list, table or panel: an icon, a title, a one-line
 * hint, and an optional call to action — so an empty page says what belongs here
 * and how to get some. `icon={null}` drops the icon for a cramped spot (a table
 * cell, a side rail); `bordered` frames it as a dashed panel when it stands alone
 * on a page rather than inside a card. Sites that sat flush-left inside a card
 * keep that through `className`.
 */
export function EmptyState({
  action,
  bordered = false,
  className,
  hint,
  icon = 'empty',
  title,
}: {
  action?: ReactNode;
  bordered?: boolean;
  className?: string;
  hint?: ReactNode;
  icon?: IconName | null;
  title: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center px-4 py-10 text-center',
        bordered && 'rounded-xl border border-dashed border-ink-400 bg-ink-900/30',
        className
      )}
    >
      {icon && (
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-ink-400 bg-ink-700 text-paper-500">
          <Icon name={icon} size={18} />
        </div>
      )}
      <p className="text-sm font-medium text-paper-200">{title}</p>
      {hint && <p className="mt-1 max-w-md text-[13px] leading-relaxed text-paper-500">{hint}</p>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
