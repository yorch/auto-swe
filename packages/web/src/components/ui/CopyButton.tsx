'use client';

import { useTransientFlag } from '@/hooks/useTransientFlag';
import { cn, FOCUS_RING } from '@/lib/utils';

interface CopyButtonProps {
  value: string;
  className?: string;
}

export function CopyButton({ value, className }: CopyButtonProps) {
  const [copied, markCopied] = useTransientFlag();
  const [failed, markFailed] = useTransientFlag(3000);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      markCopied();
    } catch {
      // Clipboard access is refused on insecure origins and when permission is denied.
      markFailed();
    }
  };

  return (
    <>
      <button
        className={cn(
          'inline-flex items-center rounded border border-ink-600 bg-ink-800 px-2 py-0.5 font-mono text-[10px] text-paper-400 transition-colors hover:border-ember-400 hover:text-ember-400',
          FOCUS_RING,
          failed && 'border-brick-400 text-brick-400',
          className
        )}
        onClick={handleCopy}
        title="Copy to clipboard"
        type="button"
      >
        {failed ? 'copy failed' : copied ? 'copied' : 'copy'}
      </button>
      {/* Announces the outcome; the button's own label change is not read out. */}
      <span aria-live="polite" className="sr-only" role="status">
        {copied ? 'Copied to clipboard' : failed ? 'Could not copy to clipboard' : ''}
      </span>
    </>
  );
}
