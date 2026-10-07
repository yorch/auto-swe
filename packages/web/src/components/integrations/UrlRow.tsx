import type { ReactNode } from 'react';
import { CopyButton } from '@/components/ui/CopyButton';

interface UrlRowProps {
  label: string;
  url: string;
  /** Where to register the URL, rendered under the row. */
  help?: ReactNode;
}

/** Read-only URL the admin registers elsewhere (webhook, OAuth callback), with a copy button. */
export function UrlRow({ label, url, help }: UrlRowProps) {
  return (
    <div className="space-y-1">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
        <span className="text-[13px] text-paper-300 sm:w-44 sm:shrink-0">{label}</span>
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-ink-500 bg-ink-900/60 py-1 pr-1 pl-2.5">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-paper-200" title={url}>
            {url}
          </code>
          <CopyButton value={url} />
        </div>
      </div>
      {help && <p className="text-xs leading-relaxed text-paper-500">{help}</p>}
    </div>
  );
}
