import { CopyButton } from '@/components/ui/CopyButton';

interface UrlRowProps {
  label: string;
  url: string;
}

export function UrlRow({ label, url }: UrlRowProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-[11px] text-paper-500">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded-sm border border-ink-700 bg-ink-900 px-2 py-1 font-mono text-[11px] text-paper-300">
        {url}
      </code>
      <CopyButton value={url} />
    </div>
  );
}
