'use client';

import { Icon } from '@/components/ui/Icon';
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
          'inline-flex items-center gap-1 rounded-md border border-ink-500 bg-ink-700 px-2 py-0.5 text-[11.5px] font-medium text-paper-400 transition-colors hover:border-ember-400/60 hover:text-paper-100',
          FOCUS_RING,
          failed && 'border-brick-400 text-brick-400',
          className
        )}
        onClick={handleCopy}
        title="Copy to clipboard"
        type="button"
      >
        <Icon name={copied ? 'check' : 'copy'} size={12} />
        {failed ? 'Copy failed' : copied ? 'Copied' : 'Copy'}
      </button>
      {/* Announces the outcome; the button's own label change is not read out. */}
      <span aria-live="polite" className="sr-only" role="status">
        {copied ? 'Copied to clipboard' : failed ? 'Could not copy to clipboard' : ''}
      </span>
    </>
  );
}
