import type { ReactNode } from 'react';

/** One label / value row of a `<dl>` summary, divided from the row above it. */
export function KeyValueRow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-ink-600 pt-2 first:border-t-0 first:pt-0">
      <dt className="text-[13px] text-paper-400">{label}</dt>
      <dd className="min-w-0 truncate text-right text-[13px] font-medium text-paper-100 tabular-nums">
        {children}
      </dd>
    </div>
  );
}
