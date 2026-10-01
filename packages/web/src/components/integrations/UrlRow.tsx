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
      <div className="flex items-center gap-2">
        <span className="label-mono w-40 shrink-0">{label}</span>
        <code className="min-w-0 flex-1 truncate rounded-sm border border-ink-600 bg-ink-900 px-2 py-1 font-mono text-[11px] text-paper-300">
          {url}
        </code>
        <CopyButton value={url} />
      </div>
      {help && <p className="text-[11px] text-paper-600">{help}</p>}
    </div>
  );
}
