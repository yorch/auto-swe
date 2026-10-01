import type { ReactNode } from 'react';

/** One label / value row of a `<dl>` summary, divided from the row above it. */
export function KeyValueRow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-ink-600 pt-2 first:border-t-0 first:pt-0">
      <dt className="label-mono">{label}</dt>
      <dd className="tabular min-w-0 truncate text-right font-mono text-sm text-paper-100">
        {children}
      </dd>
    </div>
  );
}
