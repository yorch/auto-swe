import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Table column header. The tables across the admin and users pages share one
 * header treatment, so it lives here rather than as a local copy per page.
 */
export function Th({
  children,
  align = 'left',
}: {
  children?: ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      className={cn(
        'px-4 py-3 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-paper-500',
        align === 'right' ? 'text-right' : 'text-left'
      )}
    >
      {children}
    </th>
  );
}
