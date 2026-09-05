import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * "Nothing here yet" copy for a list or table. Centred, muted, with room for a
 * one-line hint and an optional call to action. Sites that sat flush-left
 * inside a card keep that through `className`.
 */
export function EmptyState({
  action,
  className,
  hint,
  title,
}: {
  action?: ReactNode;
  className?: string;
  hint?: ReactNode;
  title: ReactNode;
}) {
  return (
    <div className={cn('py-8 text-center text-sm text-paper-400', className)}>
      <p>{title}</p>
      {hint && <p className="mt-1 text-xs text-paper-500">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
